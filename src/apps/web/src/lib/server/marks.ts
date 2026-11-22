/**
 * marks.ts — S3 valuation marks + the S3-RD1 reconcile primitive.
 * ============================================================================
 * A valuation mark is how a pure-ledger app tracks MARKET movement: the user
 * asserts "it's now worth ₹X" and the system posts ONE non-transfer adjustment
 * row whose amount is the GAP to reach that value (beancount pad/balance). Value
 * is therefore always derived (`opening + Σtx`) and can never disagree across
 * screens; a mark moves value ONLY, never cost basis (it has no transferPartnerId
 * — S2/holdingValued), and is excluded from spending/income analytics.
 *
 * TWO invariants owned here:
 *
 *  1. GAP MATH (S3 AC). The posted amount = `target − running value immediately
 *     before this row`, so the running value AFTER the row equals the target
 *     exactly. The mark is inserted at the end of its date (max sequence + 1), so
 *     "the value immediately before it" == the balance of all rows dated ≤ that
 *     date == `accountBalance(sqlite, id, date)`. Zero-gap → a ₹0 row (S3 RD8; was none, S3 RD3).
 *
 *  2. RE-DERIVATION / RECONCILE (S3 RD1, LOCKED). A mark means "it was worth ₹X
 *     on that date" — so when a PRIOR row changes (a back-dated contribution is
 *     edited, a row is deleted/restored/reordered), the mark HOLDS its asserted
 *     target and RE-DERIVES its gap so value-after-mark still equals the target.
 *     `reconcileMarks` walks the account's live ledger in (date, sequence) order
 *     and rewrites every mark's amount to `target − runningBefore`. It runs after
 *     the mark post AND after every capture/edit mutation on a MARKABLE account
 *     (wired in transactions.ts / transfers.ts) — so RD1 holds by construction.
 *
 * `mark_target_paise` stores the SIGNED target value-after (a liability holding's
 * outstanding is negative — the sign is applied by the caller from module side,
 * the one place side is read; aggregation never branches on concrete type).
 *
 * Circular-import note: this module imports `nextSequenceOn` + the shared error
 * classes from transactions.ts, and transactions.ts imports `reconcileMarks`
 * from here. Both are used only inside function bodies (never at module-eval
 * time), so the ESM cycle is runtime-safe.
 * ============================================================================
 */
import { isRealDate } from '../dates';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getModule, hasModule } from '@miserly/core';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { accountBalance } from './db/balances';
import { formatDate as formatDisplayDate } from '../dates';
import { isAccountVisibleTo, holdsOnDate } from './visibility';
import {
  nextSequenceOn,
  AccountNotFoundError,
  ClosedAccountError,
  StaleEditError,
  requireHeldDate,
} from './transactions';

type AppDb = Db['db'];

/** Thrown for a value update dated before the account's start (its opening date): the value it
 *  states would sit before the money it is a value of (2026-11-06). */
export class MarkBeforeStartError extends Error {
  constructor(openingDate: string) {
    super(`A value update can't be dated before the account's start (${formatDisplayDate(openingDate)})`);
    this.name = 'MarkBeforeStartError';
  }
}

/** Thrown when a mark is attempted on a non-markable account (Bank, Credit Card).
 *  Their balance is real recorded cash, reconciled by transactions, not asserted. */
export class NotMarkableError extends Error {
  constructor() {
    super('This account is valued by its transactions, not by a marked value');
    this.name = 'NotMarkableError';
  }
}

/** True if the module for `type` accepts valuation marks (reads metadata, never
 *  an `if type===` branch). Unknown type → false. */
export function isMarkableType(type: string): boolean {
  return hasModule(type) && getModule(type).metadata.markable;
}

/**
 * Re-derive every valuation-mark row's gap on `accountId` so that each mark's
 * running-value-after equals its stored `mark_target_paise` (S3 RD1). Idempotent:
 * a mark already holding its target is left untouched (no needless updated_at
 * bump). Walks the LIVE ledger in (date, sequence) order over the same amounts
 * the balance window function sums, so it can never disagree with balances.ts.
 *
 * Self-gating: a NON-markable account (Bank, Credit Card) has no marks, so this
 * early-returns after one PK read — callers can invoke it unconditionally after
 * any capture/edit mutation without a markability check of their own.
 *
 * MUST run inside the caller's write transaction (so it sees that mutation's rows
 * and commits atomically with it). Pass the transaction handle as `db`.
 */
export function reconcileMarks(db: AppDb, accountId: string, nowIso: string): void {
  const account = db
    .select({ opening: schema.accounts.openingPaise, type: schema.accounts.type })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account || !isMarkableType(account.type)) return;

  const rows = db
    .select({
      id: schema.transactions.id,
      amountPaise: schema.transactions.amountPaise,
      kind: schema.transactions.kind,
      markTargetPaise: schema.transactions.markTargetPaise,
    })
    .from(schema.transactions)
    .where(
      and(eq(schema.transactions.accountId, accountId), isNull(schema.transactions.deletedAt)),
    )
    .orderBy(asc(schema.transactions.date), asc(schema.transactions.sequence))
    .all();

  let running = account.opening;
  for (const r of rows) {
    if (r.kind === 'valuationMark' && r.markTargetPaise !== null) {
      const desired = r.markTargetPaise - running;
      if (desired !== r.amountPaise) {
        db.update(schema.transactions)
          .set({ amountPaise: desired, updatedAt: nowIso })
          .where(eq(schema.transactions.id, r.id))
          .run();
      }
      running = r.markTargetPaise; // value-after == target, by construction
    } else {
      running += r.amountPaise;
    }
  }
}

export interface PostMarkInput {
  readonly accountId: string;
  /** The SIGNED target value-after (what currentValue should become). For a
   *  liability holding this is negative (outstanding owed). The caller applies
   *  the sign from the module side. */
  readonly targetPaise: number;
  /** Civil date 'YYYY-MM-DD'. Past/future allowed (S3). */
  readonly date: string;
}

export interface PostMarkResult {
  /** The new mark row id (a matching value records a ₹0 row; null is never returned now). */
  readonly id: string | null;
  /** The gap posted (target − running-before); 0 when skipped. */
  readonly gapPaise: number;
}

/**
 * Post a valuation mark on a markable holding account. Validates visible + open +
 * markable + sign-consistent target, computes the gap against the running value
 * at end of `date`, inserts one `kind='valuationMark'` row (₹0 when it matches), and
 * reconciles the account's marks. All inside ONE transaction.
 */
export async function postValuationMark(
  database: Db,
  actor: { readonly userId: string },
  input: PostMarkInput,
): Promise<PostMarkResult> {
  const { db, sqlite } = database;

  if (!(await isAccountVisibleTo(db, actor.userId, input.accountId))) {
    throw new AccountNotFoundError();
  }
  const account = db
    .select({ status: schema.accounts.status, type: schema.accounts.type, openingDate: schema.accounts.openingDate })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, input.accountId), isNull(schema.accounts.deletedAt)))
    .get();
  if (!account) throw new AccountNotFoundError();
  if (account.status !== 'open') throw new ClosedAccountError();
  if (!isMarkableType(account.type)) throw new NotMarkableError();
  // C5 C: a member updates the value only on the dates they hold the account.
  requireHeldDate(db, actor.userId, input.accountId, input.date);

  if (!Number.isSafeInteger(input.targetPaise)) {
    throw new Error('postValuationMark: targetPaise must be a safe integer');
  }
  // Sign follows the module side: an asset holding marks to a value ≥ 0; a
  // liability holding marks to its outstanding ≤ 0 (S3 validation). Reads
  // metadata side, never a concrete-type branch.
  const side = getModule(account.type).metadata.side;
  if (side === 'Asset' && input.targetPaise < 0) {
    throw new Error('postValuationMark: an asset holding cannot be marked to a negative value');
  }
  if (side === 'Liability' && input.targetPaise > 0) {
    throw new Error('postValuationMark: a liability holding is marked to its outstanding (≤ 0)');
  }

  if (!isRealDate(input.date)) {
    throw new Error(`postValuationMark: date must be a real day as 'YYYY-MM-DD', got '${input.date}'`);
  }
  if (account.openingDate !== null && input.date < account.openingDate) throw new MarkBeforeStartError(account.openingDate);

  const id = randomUUID();
  const nowIso = new Date().toISOString();
  let gap = 0;
  let created = false;

  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    // Running value immediately before a row appended at end of `date`.
    const before = accountBalance(sqlite, input.accountId, input.date);
    gap = input.targetPaise - before;
    // N-04 (S3 RD8): a value that matches still records a ₹0 row, so "Last
    // updated" and the return per year see the confirmation (it created no row before, S3 RD3).

    const sequence = nextSequenceOn(txDb, input.accountId, input.date);
    tx.insert(schema.transactions)
      .values({
        id,
        accountId: input.accountId,
        date: input.date,
        sequence,
        amountPaise: gap,
        markTargetPaise: input.targetPaise,
        enteredBy: actor.userId,
        kind: 'valuationMark',
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();
    created = true;

    // Re-derive any later marks whose "before" value just shifted (S3 RD1).
    reconcileMarks(txDb, input.accountId, nowIso);
  });

  return { id: created ? id : null, gapPaise: gap };
}

/**
 * Edit an existing mark's asserted target (S3 recovery path). Sets the new signed
 * target and reconciles, so the mark's gap re-derives and value-after == the new
 * target. Optimistic on `expectedUpdatedAt` (a concurrent change → StaleEditError,
 * reusing the C4 posture). Deleting a mark is an ordinary C4 delete.
 */
export async function editMarkTarget(
  database: Db,
  actor: { readonly userId: string },
  markId: string,
  newTargetPaise: number,
  expectedUpdatedAt: string,
  /** A value update's date and memo edit in place too (item 2.5); undefined = leave. */
  extra: { readonly date?: string; readonly notes?: string | null } = {},
): Promise<{ updatedAt: string }> {
  const { db } = database;

  const row = db
    .select()
    .from(schema.transactions)
    .where(and(eq(schema.transactions.id, markId), isNull(schema.transactions.deletedAt)))
    .get();
  if (!row) throw new AccountNotFoundError();
  if (!(await isAccountVisibleTo(db, actor.userId, row.accountId))) throw new AccountNotFoundError();
  // C5 C: a value update dated outside the actor's days on the account is not theirs to see.
  if (!holdsOnDate(db, actor.userId, row.accountId, row.date)) throw new AccountNotFoundError();
  if (row.kind !== 'valuationMark') throw new NotMarkableError();
  if (extra.date !== undefined && extra.date !== row.date) requireHeldDate(db, actor.userId, row.accountId, extra.date);
  if (!Number.isSafeInteger(newTargetPaise)) {
    throw new Error('editMarkTarget: targetPaise must be a safe integer');
  }
  if (extra.date !== undefined && !isRealDate(extra.date)) {
    throw new Error(`editMarkTarget: date must be a real day as 'YYYY-MM-DD', got '${extra.date}'`);
  }
  const account = db
    .select({ status: schema.accounts.status, type: schema.accounts.type, openingDate: schema.accounts.openingDate })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, row.accountId))
    .get();
  if (account && account.status !== 'open') throw new ClosedAccountError();
  // A changed date can't go before the start; one typed before this rule keeps its date.
  if (extra.date !== undefined && extra.date !== row.date && account?.openingDate && extra.date < account.openingDate) {
    throw new MarkBeforeStartError(account.openingDate);
  }
  // The same sign rule as posting one (an asset's value ≥ 0, a liability's outstanding ≤ 0).
  const side = account ? getModule(account.type).metadata.side : null;
  if (side === 'Asset' && newTargetPaise < 0) {
    throw new Error('editMarkTarget: an asset holding cannot be marked to a negative value');
  }
  if (side === 'Liability' && newTargetPaise > 0) {
    throw new Error('editMarkTarget: a liability holding is marked to its outstanding (≤ 0)');
  }

  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    const set: Partial<typeof schema.transactions.$inferInsert> = { markTargetPaise: newTargetPaise, updatedAt: nowIso };
    if (extra.notes !== undefined) set.notes = extra.notes?.trim() ? extra.notes.trim() : null;
    if (extra.date !== undefined && extra.date !== row.date) {
      set.date = extra.date;
      set.sequence = nextSequenceOn(txDb, row.accountId, extra.date);
    }
    const res = tx
      .update(schema.transactions)
      .set(set)
      .where(
        and(
          eq(schema.transactions.id, markId),
          eq(schema.transactions.updatedAt, expectedUpdatedAt),
          isNull(schema.transactions.deletedAt),
        ),
      )
      .run();
    // Optimistic-concurrency failure → roll back + surface the shared C4 error.
    if (res.changes !== 1) throw new StaleEditError();
    reconcileMarks(txDb, row.accountId, nowIso);
  });

  return { updatedAt: nowIso };
}
