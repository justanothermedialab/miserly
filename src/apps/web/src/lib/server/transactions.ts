/**
 * transactions.ts — the C1/C2 capture core (create + the register read model).
 * ============================================================================
 * THE money-write path. Every general transaction — register quick-add (C1),
 * global quick-add (C2), and later the C4 edit machinery — funnels through this
 * ONE service, so there is exactly one validation, one sequence convention, and
 * one balance computation (the C1/C2 "shared service" discipline: a row created
 * anywhere is indistinguishable from a row created anywhere else).
 *
 * Correctness invariants owned here:
 *
 *  1. ORDERING. A new row's `sequence` = MAX(sequence) + 1 within its
 *     (account, date) — `nextSequenceOn` below — so same-date entries keep
 *     entry order (C1 RD1: newest on top in the date-desc view) and a
 *     back-dated insert lands correctly WITHOUT touching other rows (the
 *     Actual #3928 fix, re-proven at M6). The MAX deliberately INCLUDES
 *     tombstoned rows: a sequence is never reissued while its row is merely
 *     soft-deleted, so a C4 undo/restore can never collide with a row created
 *     in between. One convention for ALL writers (closeAccount uses this too).
 *
 *  2. PRIVACY (P0). The actor must be able to SEE the account (`owned ∪
 *     member-of`) or the service throws `AccountNotFoundError` — the same error
 *     a genuinely-missing id throws, so a probe can't distinguish "not mine"
 *     from "not real". Checked server-side here, never UI-only.
 *
 *  3. DIRECTION. Amounts arrive as SIGNED integer paise (inflow > 0,
 *     outflow < 0) — the boundary (validation.ts) owns the two-column
 *     exactly-one rule and the rupees→paise conversion; this service refuses
 *     zero/unsafe amounts as a defense in depth. No float ever touches money.
 *
 *  4. DERIVED BALANCE. Nothing here stores a balance. The register read model
 *     (`registerView`) computes per-row running balances with the SAME
 *     crown-jewel window-fn shape as balances.ts (ORDER BY date, sequence;
 *     ROWS frame; deleted_at IS NULL) — extended with the display joins —
 *     and the as-of-today / projected split comes from `accountBalance`.
 *
 * Payee resolution (`resolvePayee`) runs BEFORE the write transaction — it is
 * independently race-safe (ON CONFLICT + re-read), and a payee row that
 * survives a failed transaction write is a harmless registry entry, not a
 * ledger inconsistency. Projections (`account_payee`, `user_payee`) update
 * INSIDE the write transaction: a saved row and its recency/remembered-category
 * commit together (F3 — remembered category is set only when the row carries a
 * category; a category-less save never clears an existing memory).
 *
 * R8: service functions are async although better-sqlite3 is sync.
 * ============================================================================
 */
import { isRealDate } from '../dates';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { today, formatDate, parseDate, hasModule, getModule } from '@miserly/core';
import { appClock } from './clock';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { accountBalance } from './db/balances';
import { formatDate as displayDate } from '../dates';
import {
  isAccountVisibleTo,
  accountsVisibleTo,
  accountsReadableBy,
  isAccountReadableBy,
  viewerStretches,
  inStretches,
  heldRowSql,
  heldRowCondition,
  heldRowsIn,
  scopeOn,
  heldScope,
  holdsOnDate,
  canWriteOn,
  SINCE_START,
  type Stretch,
} from './visibility';
import { earnedPayeeIds, ownUnusedPayeeIds, resolvePayee } from './payees';
import { normalizeName } from './names';
import { linkageRateFrom } from './rates';
import { isPickableCategory, categoryPickable } from './category-rules';
import { accountLabel, sectionedName } from '../transfer-targets';
import { sharedNamesOf } from './account-names';
// S3 RD1: after any mutation that can shift a MARKABLE account's running balance,
// re-derive its valuation marks so each still holds its asserted target. A cheap
// no-op for spending accounts (they have no marks). Runtime-only ESM cycle with
// marks.ts (it imports nextSequenceOn/errors from here) — safe, see marks.ts.
import { reconcileMarks } from './marks';
import { LISTED_NOTE_CHARS, listedNoteSql } from './listed-notes';

type AppDb = Db['db'];

/** True if the module for `type` sits on the Liability side (register wording:
 *  Charge/Payment instead of Withdrawal/Deposit). Reads module METADATA, never
 *  an `if type===` branch (architecture §5). Unknown type → false (asset-style). */
function isLiabilityType(type: string): boolean {
  return hasModule(type) && getModule(type).metadata.side === 'Liability';
}

/** True if the module for `type` is a SPENDING-class account (Bank, Credit Card)
 *  — the C5 inbox scope. Reads module metadata, never an `if type===` branch. */
export function isSpendingType(type: string): boolean {
  return hasModule(type) && getModule(type).metadata.accountClass === 'spending';
}

/**
 * True if a transfer between accounts of these two types takes a category: one side a SPENDING
 * account (bank, card), the other a HOLDING (fund, stocks, FD, RD, gold, property, loan, other)
 * — money leaving or entering the cash a person spends from (Actual: on budget ↔ off budget;
 * item 2.5 decision, 2026-10-16). Bank ↔ bank, card bills and holding ↔ holding take none. The
 * category sits on the spending-side leg (`categoryLegOf`). Module metadata, never `if type===`.
 */
export function transferTakesCategory(typeA: string, typeB: string): boolean {
  return isSpendingType(typeA) !== isSpendingType(typeB);
}

/** Of a transfer's two legs (their account types given), the one that holds its category. */
function categoryLegOf<T>(self: T, selfType: string, partner: T): T {
  return isSpendingType(selfType) ? self : partner;
}

/** The account type of each id (live accounts). */
function accountTypes(db: AppDb, ids: readonly string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: schema.accounts.id, type: schema.accounts.type })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, [...new Set(ids)]))
      .all()
      .map((a) => [a.id, a.type]),
  );
}

/**
 * Thrown when the target account does not exist OR is not visible to the actor.
 * ONE error for both cases (message = the route's 404 body) so existence is
 * never leaked through a distinguishable failure (P0 anti-enumeration).
 */
export class AccountNotFoundError extends Error {
  constructor() {
    super('Not found');
    this.name = 'AccountNotFoundError';
  }
}

/** Thrown when writing into a closed account (reopen first — F1/C2 rule). Nothing on a closed
 *  account changes, so every writer throws this, with its own wording if it needs one. */
export class ClosedAccountError extends Error {
  constructor(message = 'This account is closed. Reopen it to add transactions.') {
    super(message);
    this.name = 'ClosedAccountError';
  }
}

/**
 * A row dated outside the days the actor holds a shared account (C5 C, H2 RD9): a member writes
 * only the dates since they joined. A kind of "can't write here", so every form that shows a
 * closed account's message shows this one.
 */
export class NotHeldDateError extends ClosedAccountError {
  constructor(from: string) {
    super(`This account was shared with you on ${displayDate(from)}. Rows dated before that stay with its owner.`);
    this.name = 'NotHeldDateError';
  }
}

/** Refuse a row dated `date` on `accountId` unless the actor holds that day (the owner, any day). */
export function requireHeldDate(db: AppDb, userId: string, accountId: string, date: string): void {
  if (holdsOnDate(db, userId, accountId, date)) return;
  const stretches = viewerStretches(db, userId, [accountId]).get(accountId) ?? [];
  const open = stretches.find((x) => x.to === null);
  throw new NotHeldDateError(open?.from ?? stretches[stretches.length - 1]?.from ?? date);
}

/** Thrown when the given category id is missing, tombstoned, or hidden (F2). */
export class InvalidCategoryError extends Error {
  constructor() {
    super('Choose an existing category');
    this.name = 'InvalidCategoryError';
  }
}

/**
 * Thrown by an edit/delete whose `expectedUpdatedAt` no longer matches the row
 * (a concurrent writer changed it first — C4 optimistic concurrency, OQ#5). The
 * caller re-reads and retries; a co-member's correction is never silently
 * overwritten.
 */
export class StaleEditError extends Error {
  constructor() {
    super('This transaction changed since you loaded it. Reload and try again.');
    this.name = 'StaleEditError';
  }
}

/** Thrown when a category is set on a transfer that takes none (`transferTakesCategory`, C3). */
export class TransferCategoryError extends Error {
  constructor() {
    super('Only a transfer to or from an investment, property or loan takes a category');
    this.name = 'TransferCategoryError';
  }
}

/**
 * Next `sequence` within (account, date): MAX + 1, first row = 0 (the engine's
 * `nextSequence` convention — one convention across all writers).
 *
 * DELIBERATELY counts tombstoned rows too (no `deleted_at` filter): a
 * soft-deleted row still owns its (date, sequence) slot so that restoring it
 * (C4 undo) can never produce two live rows with the same ordering key — the
 * (date, sequence) key must stay unique for the ledger order to be
 * deterministic and reproducible.
 */
export function nextSequenceOn(db: AppDb, accountId: string, date: string): number {
  const row = db
    .select({
      max: sql<number>`COALESCE(MAX(${schema.transactions.sequence}), -1)`,
    })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.accountId, accountId), eq(schema.transactions.date, date)))
    .get();
  return (row?.max ?? -1) + 1;
}

export interface CreateTransactionInput {
  readonly accountId: string;
  /** Civil date 'YYYY-MM-DD'. Past/future allowed (C1). */
  readonly date: string;
  /** SIGNED integer paise: inflow > 0, outflow < 0. Never 0. */
  readonly amountPaise: number;
  /** Typed payee text → resolved/created via the F3 registry. Null = none. */
  readonly payeeName?: string | null;
  /** Existing, non-hidden category id. Null = uncategorized (→ C5 inbox). */
  readonly categoryId?: string | null;
  readonly notes?: string | null;
}

/** The created row, as the register needs it back (ids + ordering + audit). */
export interface CreatedTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly date: string;
  readonly sequence: number;
  readonly amountPaise: number;
  readonly categoryId: string | null;
  readonly payeeId: string | null;
  readonly payeeName: string | null;
  readonly notes: string | null;
  readonly enteredBy: string;
  /** ms-precision ISO — the optimistic-concurrency token for a later C4 edit. */
  readonly updatedAt: string;
}

/**
 * Create one ordinary transaction. THE single create path for C1 and C2 (and
 * C4's duplicate). Validates: account visible + open; signed non-zero safe
 * amount; date shape; category live + non-hidden if set. Assigns the per-date
 * sequence and writes the row + payee projections in ONE transaction.
 */
export async function createTransaction(
  database: Db,
  actor: { readonly userId: string },
  input: CreateTransactionInput,
): Promise<CreatedTransaction> {
  const { db } = database;

  // ── validate (checks precede the write tx; better-sqlite3 serializes) ──────
  if (!(await isAccountVisibleTo(db, actor.userId, input.accountId))) {
    throw new AccountNotFoundError();
  }
  const account = db
    .select({ status: schema.accounts.status })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, input.accountId), isNull(schema.accounts.deletedAt)))
    .get();
  if (!account) throw new AccountNotFoundError();
  if (account.status !== 'open') throw new ClosedAccountError();

  if (!isRealDate(input.date)) {
    throw new Error(`createTransaction: date must be a real day as 'YYYY-MM-DD', got '${input.date}'`);
  }
  requireHeldDate(db, actor.userId, input.accountId, input.date);
  if (
    !Number.isSafeInteger(input.amountPaise) ||
    input.amountPaise === 0
  ) {
    throw new Error('createTransaction: amountPaise must be a non-zero safe integer');
  }

  const categoryId = input.categoryId ?? null;
  if (categoryId !== null) {
    if (!isPickableCategory(db, categoryId)) throw new InvalidCategoryError();
  }

  // ── resolve payee (race-safe on its own; harmless if the write later fails) ─
  const payeeText = input.payeeName?.trim() ?? '';
  const payee = payeeText === '' ? null : await resolvePayee(db, payeeText);

  const id = randomUUID();
  const notes = input.notes?.trim() ? input.notes.trim() : null;
  const nowIso = new Date().toISOString();

  let sequence = 0;
  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    sequence = nextSequenceOn(txDb, input.accountId, input.date);

    tx.insert(schema.transactions)
      .values({
        id,
        accountId: input.accountId,
        date: input.date,
        sequence,
        amountPaise: input.amountPaise,
        categoryId,
        payeeId: payee?.id ?? null,
        enteredBy: actor.userId,
        kind: 'ordinary',
        notes,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();

    if (payee) {
      upsertPayeeProjections(txDb, {
        accountId: input.accountId,
        userId: actor.userId,
        payeeId: payee.id,
        categoryId,
        nowIso,
      });
    }

    // An ordinary row on a holding (e.g. a reinvested dividend) can precede a
    // later mark — re-derive so the mark still hits its target (self-gated).
    reconcileMarks(txDb, input.accountId, nowIso);
  });

  return {
    id,
    accountId: input.accountId,
    date: input.date,
    sequence,
    amountPaise: input.amountPaise,
    categoryId,
    payeeId: payee?.id ?? null,
    payeeName: payee?.displayName ?? null,
    notes,
    enteredBy: actor.userId,
    updatedAt: nowIso,
  };
}

/**
 * Recency + remembered-category projections for a saved (payee-carrying) row —
 * MUST run inside the same write transaction as the row itself. The remembered
 * category (`user_payee.last_category_id`) is (re)set ONLY when this save
 * carries a category: F3's "remember the LAST category used", while a
 * category-less save leaves any existing memory intact (fill-when-blank must
 * not be erased by exactly the rows it exists to help).
 */
function upsertPayeeProjections(
  db: AppDb,
  args: {
    readonly accountId: string;
    readonly userId: string;
    readonly payeeId: string;
    readonly categoryId: string | null;
    readonly nowIso: string;
  },
): void {
  const { accountId, userId, payeeId, categoryId, nowIso } = args;

  const ap = db
    .select({ accountId: schema.accountPayee.accountId })
    .from(schema.accountPayee)
    .where(
      and(eq(schema.accountPayee.accountId, accountId), eq(schema.accountPayee.payeeId, payeeId)),
    )
    .get();
  if (ap) {
    db.update(schema.accountPayee)
      .set({ lastUsedAt: nowIso, updatedAt: nowIso })
      .where(
        and(
          eq(schema.accountPayee.accountId, accountId),
          eq(schema.accountPayee.payeeId, payeeId),
        ),
      )
      .run();
  } else {
    db.insert(schema.accountPayee).values({ accountId, payeeId, lastUsedAt: nowIso }).run();
  }

  const up = db
    .select({ lastCategoryId: schema.userPayee.lastCategoryId })
    .from(schema.userPayee)
    .where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, payeeId)))
    .get();
  if (up) {
    db.update(schema.userPayee)
      .set({
        lastUsedAt: nowIso,
        updatedAt: nowIso,
        // Only a category-carrying save rewrites the memory (F3 RD1).
        ...(categoryId !== null ? { lastCategoryId: categoryId } : {}),
      })
      .where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, payeeId)))
      .run();
  } else {
    db.insert(schema.userPayee)
      .values({ userId, payeeId, lastCategoryId: categoryId, lastUsedAt: nowIso })
      .run();
  }
}

// ============================================================================
// The register read model (C1) — one query feeds the passbook.
// ============================================================================

/** One register row: the transaction + its display joins + running balance. */
export interface RegisterRow {
  readonly id: string;
  readonly date: string;
  readonly sequence: number;
  readonly amountPaise: number;
  /** opening_paise + Σ amounts up to and including this row, ledger order. */
  readonly balancePaise: number;
  readonly kind: 'ordinary' | 'valuationMark';
  /** For a valuationMark row: the asserted target value (S3); null otherwise. */
  readonly markTargetPaise: number | null;
  /** A transfer shows its spending-side leg's category on both legs (when the viewer can see
   *  that leg); an ordinary row its own. */
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  /** A transfer whose category the viewer can set here (`transferTakesCategory`, other leg
   *  visible); false for any other transfer. True for an ordinary row. */
  readonly takesCategory: boolean;
  readonly payeeId: string | null;
  readonly payeeName: string | null;
  readonly transferPartnerId: string | null;
  /** For a transfer row: the OTHER account's name (derived, never a payee), as lists show it
   *  (C8): "HDFC (Bob's)" for a co-member's account, "HDFC (closed)" for a closed one. */
  readonly counterpartAccountName: string | null;
  /** The other account's id, when the viewer can see it (the ⇆ icon jumps there). */
  readonly counterpartAccountId: string | null;
  /** For a CROSS-CURRENCY transfer row (MC2): the counterpart account's native
   *  currency + its own leg amount — display-only, so the register can show
   *  "both native legs clearly" without recomputing anything (MC3 AC). Null for
   *  an ordinary row or a same-currency transfer (nothing to disambiguate). */
  readonly counterpartCurrency: string | null;
  readonly counterpartAmountPaise: number | null;
  /** MC2's linkage rate (destination-per-1-source, scale 6 or 10), derived from the two
   *  amounts (re-derived when one is corrected), stored on
   *  BOTH legs of a cross-currency transfer. Null for an ordinary row or a
   *  same-currency transfer. MC3 display only — never recomputed here. */
  readonly fxRateScaled: number | null;
  readonly fxScale: number | null;
  readonly notes: string | null;
  readonly enteredBy: string | null;
  /** H2/H4: the author's username (join-derived display only, never authoritative
   *  — `enteredBy` above is the stored id). Null if the author's user row is
   *  gone (should not happen in practice; users are soft-deleted, not hard). */
  readonly enteredByUsername: string | null;
  /** The author's DISPLAY name — what the UI shows ("entered by Bob", CP-07). */
  readonly enteredByName: string | null;
  /** N-18: on a transfer whose other half is in the account of someone who left the Circle, their
   *  name ("From Bob (left)"); its amount, date and delete are then this half's alone. */
  readonly partnerLeft: string | null;
  /** ms-precision ISO — the optimistic-concurrency token for C4 edits. */
  readonly updatedAt: string;
}

export interface RegisterView {
  readonly account: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly currency: string;
    readonly status: 'open' | 'closed';
    readonly openingPaise: number;
    readonly openingDate: string | null;
    /** Liability module → the register labels columns Charge/Payment (C1 edge). */
    readonly liability: boolean;
    /** S5 informational fields (JSON; display-only, S5 RD8). */
    readonly infoJson: string | null;
  };
  /** Live rows in (date, sequence) ASC — ledger order. UI reverses for display
   *  and renders the synthetic "Starting balance" row from the account's
   *  opening column (F1 RD9 — it is NOT a stored transaction). */
  readonly rows: RegisterRow[];
  /** How many rows the viewer holds here, whether or not all of them came. */
  readonly total: number;
  /** Where the next, older page starts (`date|sequence`), when older rows remain; null when every
   *  row the viewer holds is in `rows`. */
  readonly next: string | null;
  /** Balance over rows dated ≤ today — the headline figure (C1 RD2). */
  readonly asOfTodayPaise: number;
  /** Balance over ALL rows, future-dated included (the projected figure). */
  readonly projectedPaise: number;
  /** Today 'YYYY-MM-DD' — the UI's future-divider boundary. */
  readonly todayDate: string;
  /**
   * What the viewer holds of this account (C5 C, H2 RD9). The owner holds every date. A member
   * sees the rows dated inside their stretches only; `joined` stands for everything before their
   * first one ("Balance when you joined"). A member who has left reads those dates and changes
   * nothing (`canWrite` false), and the figures above are the balance when they left.
   */
  readonly access: {
    /** A current holder: rows can be added and changed (inside their dates). */
    readonly canWrite: boolean;
    /** The viewer's stretches; null for the owner (every date). */
    readonly stretches: Stretch[] | null;
    /** "Balance when you joined": the balance at the end of the day before the first stretch,
     *  when anything (the opening, a row) came before it; null otherwise. */
    readonly joined: { readonly date: string; readonly balancePaise: number } | null;
    /** For a member who has left: the last day they held it. */
    readonly heldUntil: string | null;
  };
}

/** A register page's place in the ledger: a row's `(date, sequence)` (unique in one account). */
export interface RegisterCursor {
  readonly date: string;
  readonly sequence: number;
}
export function registerCursorText(c: RegisterCursor): string {
  return `${c.date}|${c.sequence}`;
}
export function parseRegisterCursor(text: string | null | undefined): RegisterCursor | null {
  const m = /^(\d{4}-\d{2}-\d{2})\|(-?\d{1,15})$/u.exec(text ?? '');
  return m ? { date: m[1]!, sequence: Number(m[2]) } : null;
}

/**
 * Which rows a register read returns: every row (the default); the newest `limit` before a
 * place (a page as the person scrolls, the first one with no place); or every row dated `from` on
 * (a save's answer, a link to a row).
 */
export type RegisterPage =
  | { readonly limit: number; readonly before?: RegisterCursor | null }
  | { readonly from: string };

/**
 * The passbook read model for one account. Visibility-gated with the SAME
 * `AccountNotFoundError` as a bogus id (P0). The running balance is computed
 * by the identical window-fn shape as balances.ts (its differential test is
 * the shared proof), over every row of the account whatever the page; the
 * payee / category / transfer-counterpart display joins are made for the
 * page's rows only (all PK joins, so the window's row set is unchanged).
 */
export async function registerView(
  database: Db,
  userId: string,
  accountId: string,
  page?: RegisterPage,
): Promise<RegisterView> {
  const { db, sqlite } = database;

  // C5 C: a member who has left still reads the dates they held (read-only).
  const canWrite = await isAccountVisibleTo(db, userId, accountId);
  if (!canWrite && !(await isAccountReadableBy(db, userId, accountId))) {
    throw new AccountNotFoundError();
  }
  const account = db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.deletedAt)))
    .get();
  if (!account) throw new AccountNotFoundError();

  // P0: the transfer-counterpart columns (name/currency/amount) are gated to the
  // viewer's READABLE set and to the dates they held the other account (C5 C), so a
  // cross-member transfer never leaks the other account's name, currency, or leg amount
  // to a non-holder. `visibleIds` always includes `accountId` (it just passed the check).
  const visibleIds = await accountsReadableBy(db, userId);
  const vParams: Record<string, string> = {};
  const vPlaceholders = visibleIds
    .map((id, i) => {
      vParams[`v${i}`] = id;
      return `@v${i}`;
    })
    .join(',');

  // C5 C: only the rows dated inside the viewer's stretches (the running balance stays the
  // account's own, computed over every row). In SQL too, so a page counts only rows it can show.
  const stretches = account.ownerId === userId ? null : (viewerStretches(db, userId, [accountId]).get(accountId) ?? []);
  const heldParams: Record<string, string> = {};
  const heldSql = (alias: string): string =>
    stretches === null
      ? '1'
      : stretches.length === 0
        ? '0'
        : stretches
            .map((st, i) => {
              heldParams[`hf${i}`] = st.from;
              if (st.to !== null) heldParams[`ht${i}`] = st.to;
              return `(${alias}.date >= @hf${i}${st.to !== null ? ` AND ${alias}.date < @ht${i}` : ''})`;
            })
            .join(' OR ');
  const before = page && 'limit' in page ? (page.before ?? null) : null;
  const pickWhere = [
    heldSql('b'),
    ...(page && 'from' in page ? ['b.date >= @from'] : []),
    ...(before ? ['(b.date, b.sequence) < (@bd, @bs)'] : []),
  ].join(' AND ');
  const pageParams = {
    ...(page && 'from' in page ? { from: page.from } : {}),
    ...(before ? { bd: before.date, bs: before.sequence } : {}),
    limit: page && 'limit' in page ? page.limit : -1,
  };

  const raw = sqlite
    .prepare(
      `WITH b AS (
         SELECT t.id, t.date, t.sequence,
           a.opening_paise + SUM(t.amount_paise) OVER (
             PARTITION BY t.account_id
             ORDER BY t.date ASC, t.sequence ASC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS balancePaise
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.account_id = @accountId
           AND t.deleted_at IS NULL
       ), pick AS (
         SELECT b.id, b.balancePaise FROM b
         WHERE ${pickWhere}
         ORDER BY b.date DESC, b.sequence DESC
         LIMIT @limit
       )
       SELECT
         t.id                  AS id,
         t.date                AS date,
         t.sequence            AS sequence,
         t.amount_paise        AS amountPaise,
         pick.balancePaise     AS balancePaise,
         t.kind                AS kind,
         t.mark_target_paise   AS markTargetPaise,
         COALESCE(t.category_id, CASE WHEN ca.id IS NOT NULL THEN pt.category_id END) AS categoryId,
         COALESCE(c.name, CASE WHEN ca.id IS NOT NULL THEN pc.name END) AS categoryName,
         a.type                AS accountType,
         ca.type               AS counterpartAccountType,
         t.payee_id            AS payeeId,
         p.display_name        AS payeeName,
         -- The other leg's id only when the viewer can see its account (P0: an id from another
         -- member's private account never reaches the page); 'hidden' still marks a transfer.
         CASE WHEN t.transfer_partner_id IS NULL THEN NULL
              WHEN ca.id IS NULL THEN 'hidden'
              ELSE t.transfer_partner_id END AS transferPartnerId,
         ca.name               AS counterpartAccountName,
         ca.owner_id           AS counterpartOwnerId,
         ca.status             AS counterpartStatus,
         cou.display_name      AS counterpartOwnerName,
         ca.id                 AS counterpartAccountId,
         ca.currency           AS counterpartCurrency,
         CASE WHEN ca.id IS NOT NULL THEN pt.amount_paise END AS counterpartAmountPaise,
         -- The rate only with the other half (S16): from a hidden half it says the hidden amount.
         CASE WHEN t.transfer_partner_id IS NULL OR ca.id IS NOT NULL THEN t.fx_rate_scaled END AS fxRateScaled,
         CASE WHEN t.transfer_partner_id IS NULL OR ca.id IS NOT NULL THEN t.fx_scale END       AS fxScale,
         ${listedNoteSql('t.notes')} AS notes,
         t.entered_by          AS enteredBy,
         eb.username           AS enteredByUsername,
         eb.display_name       AS enteredByName,
         CASE WHEN t.transfer_partner_id IS NOT NULL AND ca.id IS NULL THEN (
           SELECT lu.display_name FROM transactions lp
           JOIN accounts la ON la.id = lp.account_id
           JOIN users lu    ON lu.id = la.owner_id
           WHERE lp.id = t.transfer_partner_id AND lu.deleted_at IS NOT NULL
         ) END                 AS partnerLeft,
         t.updated_at          AS updatedAt
       FROM pick
       JOIN transactions t    ON t.id  = pick.id
       JOIN accounts a        ON a.id  = t.account_id
       LEFT JOIN categories c ON c.id  = t.category_id
       LEFT JOIN payees p     ON p.id  = t.payee_id
       LEFT JOIN transactions pt ON pt.id = t.transfer_partner_id
       LEFT JOIN accounts ca  ON ca.id = pt.account_id AND ca.id IN (${vPlaceholders}) AND ${heldRowSql('pt', '@viewer')}
       LEFT JOIN categories pc ON pc.id = pt.category_id
       LEFT JOIN users eb     ON eb.id = t.entered_by
       LEFT JOIN users cou    ON cou.id = ca.owner_id
       ORDER BY t.date ASC, t.sequence ASC`,
    )
    .all({ accountId, viewer: userId, ...vParams, ...heldParams, ...pageParams }) as (Omit<RegisterRow, 'takesCategory'> & {
      accountType: string;
      counterpartAccountType: string | null;
      counterpartOwnerId: string | null;
      counterpartStatus: string | null;
      counterpartOwnerName: string | null;
    })[];
  // "Transfer → HDFC (Mutual funds)" when the viewer sees another HDFC.
  const sameName = sharedNamesOf(db, visibleIds);
  const held = stretches === null ? raw : raw.filter((r) => inStretches(stretches, r.date));
  const rows: RegisterRow[] = held.map(({ accountType, counterpartAccountType, counterpartOwnerId, counterpartStatus, counterpartOwnerName, ...r }) => ({
    ...r,
    counterpartAccountName:
      r.counterpartAccountName === null
        ? null
        : accountLabel(
            { name: r.counterpartAccountName, type: counterpartAccountType ?? '', ownerId: counterpartOwnerId ?? userId, status: counterpartStatus ?? 'open' },
            counterpartOwnerName,
            userId,
            sameName,
          ),
    takesCategory:
      r.transferPartnerId === null
        ? r.kind === 'ordinary'
        : counterpartAccountType !== null && transferTakesCategory(accountType, counterpartAccountType),
  }));

  const todayDate = formatDate(today(appClock()));
  const firstFrom = stretches?.[0]?.from ?? null;
  const dayBeforeFirst = firstFrom === null || firstFrom === SINCE_START ? null : dayBefore(firstFrom);
  const joined =
    dayBeforeFirst !== null &&
    (account.openingPaise !== 0 ||
      sqlite.prepare('SELECT 1 FROM transactions WHERE account_id = ? AND deleted_at IS NULL AND date <= ? LIMIT 1').get(accountId, dayBeforeFirst) !== undefined)
      ? { date: firstFrom!, balancePaise: accountBalance(sqlite, accountId, dayBeforeFirst) }
      : null;
  // The opening is from before a member who joined later; neither its amount nor its date
  // reaches their page ("Balance when you joined" stands for it).
  const openingHidden = joined !== null || (firstFrom !== null && firstFrom !== SINCE_START);
  const lastTo = stretches?.[stretches.length - 1]?.to ?? null;
  const heldUntil = !canWrite && lastTo !== null ? dayBefore(lastTo) : null;
  // A member who has left sees nothing after: the figures are the balance when they left.
  const leftPaise = heldUntil === null ? null : accountBalance(sqlite, accountId, heldUntil);
  // The rows held here in all, and whether any older than the oldest returned remain.
  const total = (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM transactions b WHERE b.account_id = @accountId AND b.deleted_at IS NULL AND ${heldSql('b')}`)
    .get({ accountId, ...heldParams }) as { n: number }).n;
  const oldest = raw[0];
  const older = !page
    ? false
    : oldest === undefined
      ? 'from' in page && total > 0
      : sqlite
          .prepare(`SELECT 1 FROM transactions b WHERE b.account_id = @accountId AND b.deleted_at IS NULL AND (b.date, b.sequence) < (@od, @os) AND (${heldSql('b')}) LIMIT 1`)
          .get({ accountId, od: oldest.date, os: oldest.sequence, ...heldParams }) !== undefined;
  // A `from` read with nothing dated from then on: the next page is everything before that date.
  const next = !older ? null : registerCursorText(oldest ?? { date: (page as { from: string }).from, sequence: -1 });
  return {
    account: {
      id: account.id,
      name: account.name,
      type: account.type,
      currency: account.currency,
      status: account.status,
      openingPaise: account.openingPaise,
      openingDate: account.openingDate,
      liability: isLiabilityType(account.type),
      infoJson: account.infoJson,
      ...(openingHidden ? { openingPaise: 0, openingDate: null } : {}),
    },
    rows,
    total,
    next,
    asOfTodayPaise: leftPaise ?? accountBalance(sqlite, accountId, todayDate),
    projectedPaise: leftPaise ?? accountBalance(sqlite, accountId),
    todayDate,
    access: { canWrite, stretches, joined, heldUntil },
  };
}

/** The ISO date the day before `iso`. */
function dayBefore(iso: string): string {
  return formatDate(parseDate(iso).subtract({ days: 1 }));
}

/** A payee as the capture form needs it: identity + this viewer's remembered
 *  category (the fill-when-blank prefill source, C1/F3). */
export interface CapturePayee {
  readonly id: string;
  readonly displayName: string;
  readonly nameNormalized: string;
  readonly rememberedCategoryId: string | null;
}

/**
 * The viewer's payees for capture autocomplete + fill-when-blank prefill: those
 * recorded on an account in the viewer's visible set (`account_payee` ∩
 * `accountsVisibleTo`), each with THIS user's remembered
 * category (`user_payee.last_category_id`). Small at personal scale; loaded into
 * the register/quick-add page so payee selection can prefill the category
 * client-side (the visible half of F3 fill-when-blank — the authoritative store
 * is still `createTransaction`'s explicit categoryId). Empty before any capture.
 * Most used first (rows in the visible set), so the autocomplete's ties go to the payee
 * typed most often, as Actual's (ACTUAL-PARITY #2). A remembered category that can't be picked
 * now (hidden, or in a hidden group) reads null (N-12).
 */
export async function capturePayees(db: AppDb, userId: string): Promise<CapturePayee[]> {
  const scope = await heldScope(db, userId);
  const visible = scope.all;
  if (visible.length === 0) return [];
  // C5 C: a member earns the payees of the dates they held a shared account, nothing earlier.
  const earned = [...earnedPayeeIds(db, scope)];
  // F3 RD7: payees the viewer made on the Payees page and hasn't used yet, last (0 uses).
  const own = ownUnusedPayeeIds(db, userId);
  const ownRows =
    own.length === 0
      ? []
      : db
          .select({
            id: schema.payees.id,
            displayName: schema.payees.displayName,
            nameNormalized: schema.payees.nameNormalized,
            rememberedCategoryId: schema.userPayee.lastCategoryId,
          })
          .from(schema.payees)
          .innerJoin(schema.userPayee, and(eq(schema.userPayee.payeeId, schema.payees.id), eq(schema.userPayee.userId, userId)))
          .where(and(inArray(schema.payees.id, own), isNull(schema.payees.deletedAt)))
          .all();

  const rows = db
    .selectDistinct({
      id: schema.payees.id,
      displayName: schema.payees.displayName,
      nameNormalized: schema.payees.nameNormalized,
      rememberedCategoryId: schema.userPayee.lastCategoryId,
    })
    .from(schema.payees)
    .innerJoin(schema.accountPayee, eq(schema.accountPayee.payeeId, schema.payees.id))
    .leftJoin(
      schema.userPayee,
      and(eq(schema.userPayee.payeeId, schema.payees.id), eq(schema.userPayee.userId, userId)),
    )
    .where(
      and(
        inArray(schema.accountPayee.accountId, visible),
        inArray(schema.payees.id, earned),
        isNull(schema.payees.deletedAt),
      ),
    )
    .all();

  const uses = new Map(
    db
      .select({ payeeId: schema.transactions.payeeId, n: sql<number>`count(*)` })
      .from(schema.transactions)
      .where(and(isNull(schema.transactions.deletedAt), heldRowsIn(scope, userId)))
      .groupBy(schema.transactions.payeeId)
      .all()
      .map((u) => [u.payeeId, u.n]),
  );

  // N-12: a remembered category that was hidden (or its group) since fills nothing; it filled a
  // field the picker showed blank, and the save failed.
  const pickable = new Set(db.select({ id: schema.categories.id }).from(schema.categories).where(categoryPickable).all().map((c) => c.id));
  return [...rows, ...ownRows]
    .map((r) => ({
      id: r.id,
      displayName: r.displayName,
      nameNormalized: r.nameNormalized,
      rememberedCategoryId: r.rememberedCategoryId !== null && pickable.has(r.rememberedCategoryId) ? r.rememberedCategoryId : null,
    }))
    .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) || a.displayName.localeCompare(b.displayName));
}

/**
 * Looked up, not stored: the
 * category a transfer remembers per destination account, for this user, as a payee remembers
 * one (F3). It is read from stored rows, so nothing is written when a transfer is saved: the
 * latest transfer this user entered (newest save of either half) whose money lands in that
 * account, both accounts visible to them, whose pair has a category. Deleting it, or clearing
 * its category, falls back to the one before. Never a guess: an account no categorised transfer
 * went into has none. A remembered category that can't be picked now reads as none (N-12).
 * Keys are account ids the viewer sees; values are category ids (instance-wide data).
 */
export async function rememberedTransferCategories(db: AppDb, userId: string): Promise<Record<string, string>> {
  const visible = (await heldScope(db, userId)).all;
  if (visible.length === 0) return {};
  // The latest per destination, picked in SQL (every categorised transfer came back to be
  // walked here, on every page, as Quick add rides on the layout).
  const ids = sql.join(visible.map((id) => sql`${id}`), sql`, `);
  const rows = db.all<{ accountId: string; categoryId: string | null }>(sql`
    SELECT account_id AS accountId, category_id AS categoryId FROM (
      SELECT i.account_id, COALESCE(i.category_id, f.category_id) AS category_id,
             ROW_NUMBER() OVER (PARTITION BY i.account_id ORDER BY max(i.updated_at, f.updated_at) DESC, i.date DESC, i.sequence DESC) AS n
      FROM transactions i JOIN transactions f ON f.id = i.transfer_partner_id
      WHERE i.amount_paise > 0 AND i.kind = 'ordinary' AND i.deleted_at IS NULL AND f.deleted_at IS NULL
        AND i.entered_by = ${userId} AND i.account_id IN (${ids}) AND f.account_id IN (${ids})
        AND (i.category_id IS NOT NULL OR f.category_id IS NOT NULL)
    ) WHERE n = 1`);
  const pickable = new Set(db.select({ id: schema.categories.id }).from(schema.categories).where(categoryPickable).all().map((c) => c.id));
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.categoryId !== null && pickable.has(r.categoryId)) out[r.accountId] = r.categoryId;
  }
  return out;
}

// ============================================================================
// C4 — edit · delete · restore · duplicate · reorder · bulk. One service so the
// register, detail view, and bulk toolbar share validation + balance recompute
// (no path-specific drift). All mutations are atomic; a transfer is always
// handled as a PAIR (edit syncs the partner, delete/restore act on both).
// ============================================================================

type TxRow = typeof schema.transactions.$inferSelect;

/** Load a LIVE transaction the actor may see, or throw the shared not-found
 *  error (bogus id and not-visible are indistinguishable — P0). */
async function requireVisibleTx(db: AppDb, userId: string, id: string): Promise<TxRow> {
  const row = db
    .select()
    .from(schema.transactions)
    .where(and(eq(schema.transactions.id, id), isNull(schema.transactions.deletedAt)))
    .get();
  if (!row) throw new AccountNotFoundError();
  if (!(await isAccountVisibleTo(db, userId, row.accountId))) throw new AccountNotFoundError();
  // C5 C: a row dated outside the days the actor holds the account is not theirs to see or change.
  if (!holdsOnDate(db, userId, row.accountId, row.date)) throw new AccountNotFoundError();
  return row;
}

/** Whether the actor may write the other half of a transfer: they hold its account now, on its
 *  date (C5 C). A half they can't is never written. */
async function canWriteHalf(db: AppDb, userId: string, half: { accountId: string; date: string }): Promise<boolean> {
  return canWriteOn(db, userId, half.accountId, half.date);
}

/** Throw ClosedAccountError unless the account is open (a closed account's rows don't change). */
function requireOpen(db: AppDb, accountId: string, message?: string): void {
  const a = db.select({ status: schema.accounts.status }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (a && a.status !== 'open') throw new ClosedAccountError(message);
}

const CLOSED_CHANGE = 'This account is closed. Reopen it to change its rows.';
const CLOSED_CATEGORY_ONLY = "This account is closed: only a row's category can change. Reopen it to change the rest.";

function isClosedAccount(db: AppDb, accountId: string): boolean {
  return db.select({ status: schema.accounts.status }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).get()?.status === 'closed';
}

/** Whether a patch leaves everything but the category as the row has it (a grid save posts it all). */
function onlyCategoryChanges(db: AppDb, row: TxRow, patch: UpdateTransactionPatch): boolean {
  if (patch.date !== undefined && patch.date !== row.date) return false;
  if (patch.amountPaise !== undefined && patch.amountPaise !== row.amountPaise) return false;
  if (patch.notes !== undefined && (patch.notes?.trim() || null) !== (row.notes?.trim() || null)) return false;
  if (patch.payeeName !== undefined) {
    const current = row.payeeId
      ? db.select({ name: schema.payees.displayName }).from(schema.payees).where(eq(schema.payees.id, row.payeeId)).get()?.name ?? null
      : null;
    const typed = patch.payeeName?.trim() || null;
    if ((typed === null ? null : normalizeName(typed)) !== (current === null ? null : normalizeName(current))) return false;
  }
  return true;
}

export interface UpdateTransactionPatch {
  /** undefined = leave unchanged. */
  readonly date?: string;
  /** SIGNED integer paise; undefined = leave. Never 0. */
  readonly amountPaise?: number;
  /** undefined = leave; null = clear. Ignored on a transfer (payee is derived). */
  readonly payeeName?: string | null;
  /** undefined = leave; null = clear. On a transfer, written to its spending-side leg, and
   *  rejected unless the transfer takes one (`transferTakesCategory`). */
  readonly categoryId?: string | null;
  /** undefined = leave; null = clear. */
  readonly notes?: string | null;
}

/**
 * Edit a transaction with OPTIMISTIC concurrency (OQ#5): the primary row's
 * UPDATE requires `updated_at = expectedUpdatedAt`; if a concurrent writer moved
 * it first, zero rows change and `StaleEditError` is thrown (no silent
 * overwrite). Re-validates the C1 rules. A DATE change re-sequences the row at
 * the target date. For a TRANSFER, the partner is synced in the same
 * transaction: date/notes copy; a category goes to the spending-side leg of a transfer that
 * takes one (bank or card ↔ holding) and is rejected on any other; a payee edit is ignored
 * (payee is derived).
 *
 * Amount sync depends on the transfer's currencies. SAME-currency: the partner
 * mirrors (partner = −thisAmount), the C3 equal-and-opposite pair. CROSS-currency
 * (MC2): the partner KEEPS its own amount and the linkage rate is re-derived
 * from the two (a same-currency negation would write a wrong-currency number into the
 * other account). Each leg keeps its original role/sign; flipping a
 * cross-currency transfer's direction requires the transfer form, not a bare
 * amount edit. Returns the new `updatedAt` (the next optimistic token).
 */
export async function updateTransaction(
  database: Db,
  actor: { readonly userId: string },
  id: string,
  patch: UpdateTransactionPatch,
  expectedUpdatedAt: string,
): Promise<{ updatedAt: string }> {
  const { db } = database;
  const row = await requireVisibleTx(db, actor.userId, id);
  const isTransfer = row.transferPartnerId !== null;
  // A closed account's rows stay as they were (F1), the other leg of a transfer too: an edit
  // here would change a closed account's balance and the net worth through it. The one exception
  // (C4 RD8): an ordinary row's category, which moves no money, so a closed account's row
  // can leave To categorize. The grid re-posts the whole row; the other fields must be unchanged.
  if (isClosedAccount(db, row.accountId)) {
    if (isTransfer || row.kind !== 'ordinary' || !onlyCategoryChanges(db, row, patch)) throw new ClosedAccountError(CLOSED_CATEGORY_ONLY);
    patch = { categoryId: patch.categoryId };
  }
  const partnerRow = row.transferPartnerId
    ? db.select().from(schema.transactions).where(eq(schema.transactions.id, row.transferPartnerId)).get()
    : undefined;
  // The other half in an account the actor can't see is never written. Its amount and date
  // are refused (the grid re-posts unchanged ones, which are dropped); the memo is this leg's only.
  const hiddenPartner = partnerRow !== undefined && !(await canWriteHalf(db, actor.userId, partnerRow));
  if (hiddenPartner) {
    const amountChanged = patch.amountPaise !== undefined && patch.amountPaise !== row.amountPaise;
    const dateChanged = patch.date !== undefined && patch.date !== row.date;
    if (amountChanged || dateChanged) {
      // N-18: with them gone from the Circle, the actor changes their own half alone.
      const left = partnerOwnerLeft(db, partnerRow!.accountId);
      if (left !== null) {
        const token = await unlinkFromLeft(db, row, expectedUpdatedAt, left, actor.userId);
        // The grid re-posts the transfer's (empty) payee cell with the amount; the unlink just
        // set "Carol (left)", so only a payee typed on purpose would change it, and none was.
        return updateTransaction(database, actor, id, { ...patch, payeeName: undefined }, token);
      }
      throw await hiddenHalfError(db, row, partnerRow!, actor.userId);
    }
    patch = { ...patch, amountPaise: undefined, date: undefined };
  } else if (partnerRow) requireOpen(db, partnerRow.accountId);
  // C5 C: a new date must be one the actor holds, on both sides of a transfer.
  if (patch.date !== undefined && patch.date !== row.date) {
    requireHeldDate(db, actor.userId, row.accountId, patch.date);
    if (partnerRow) requireHeldDate(db, actor.userId, partnerRow.accountId, patch.date);
  }
  // A transfer's category lives on its spending-side leg (bank or card), and only a transfer
  // between a spending account and a holding takes one: both registers show and edit that leg's.
  const types = accountTypes(db, partnerRow ? [row.accountId, partnerRow.accountId] : [row.accountId]);
  const takesCategory = partnerRow !== undefined && transferTakesCategory(types.get(row.accountId) ?? '', types.get(partnerRow.accountId) ?? '');
  const categoryLeg = takesCategory ? categoryLegOf(row, types.get(row.accountId) ?? '', partnerRow!) : row;
  // The grid posts the whole row on every cell save: only a CHANGED category is checked and
  // written, so a row whose category was hidden later still takes an edit to its memo or amount.
  if (patch.categoryId !== undefined && (patch.categoryId ?? null) === categoryLeg.categoryId) {
    patch = { ...patch, categoryId: undefined };
  }
  if (isTransfer && patch.categoryId !== undefined && !takesCategory) {
    if (patch.categoryId === null) patch = { ...patch, categoryId: undefined };
    else throw new TransferCategoryError();
  }
  // The category of a transfer whose spending leg is the other side: that leg must be one the
  // actor can see (P0: a member never writes to an account they can't see).
  // The register shows no category for such a leg, so its saves post a blank one: left alone.
  if (patch.categoryId !== undefined && categoryLeg !== row && hiddenPartner) {
    if (patch.categoryId === null) patch = { ...patch, categoryId: undefined };
    else throw new HiddenTransferError(whoCanChange(db, row, actor.userId));
  }

  if (patch.amountPaise !== undefined) {
    if (!Number.isSafeInteger(patch.amountPaise) || patch.amountPaise === 0) {
      throw new Error('updateTransaction: amountPaise must be a non-zero safe integer');
    }
  }
  if (patch.date !== undefined && !isRealDate(patch.date)) {
    throw new Error(`updateTransaction: date must be a real day as 'YYYY-MM-DD', got '${patch.date}'`);
  }
  if (patch.categoryId !== undefined && patch.categoryId !== null) {
    if (!isPickableCategory(db, patch.categoryId)) throw new InvalidCategoryError();
  }

  // Resolve a payee edit (ordinary rows only) BEFORE the write tx. An unchanged name is left
  // alone (nothing to resolve).
  let newPayeeId: string | null | undefined;
  if (!isTransfer && patch.payeeName !== undefined) {
    const text = patch.payeeName?.trim() ?? '';
    const current = row.payeeId
      ? db.select({ name: schema.payees.nameNormalized }).from(schema.payees).where(eq(schema.payees.id, row.payeeId)).get()?.name ?? null
      : null;
    if (text === '') newPayeeId = row.payeeId === null ? undefined : null;
    else if (current !== normalizeName(text)) newPayeeId = (await resolvePayee(db, text)).id;
  }

  // MC2 (2026-10-16): a cross-currency transfer's two amounts are the facts (the USD that
  // left one account, the INR that reached the other); its linkage rate follows from them.
  // Correcting either amount KEEPS the other leg's amount and re-derives the rate on both legs
  // (Quicken: "change one end of the transfer without making the corresponding change at the other
  // end"; MMEX, Firefly III and Sure store both amounts too). Each leg keeps its ORIGINAL role/sign
  // (source < 0, dest > 0): we take the magnitude of the new amount.
  const isCrossCurrencyTransfer =
    isTransfer && row.fxRateScaled !== null && row.fxScale !== null && partnerRow !== undefined;
  let fxPrimaryAmount: number | undefined;
  let fxRate: { scaled: number; scale: number } | undefined;
  if (isCrossCurrencyTransfer && patch.amountPaise !== undefined) {
    const editedWasSource = row.amountPaise < 0;
    const mag = Math.abs(patch.amountPaise);
    fxPrimaryAmount = editedWasSource ? -mag : mag;
    const other = Math.abs(partnerRow!.amountPaise);
    fxRate = editedWasSource ? linkageRateFrom(mag, other) : linkageRateFrom(other, mag);
  }

  const nowIso = new Date().toISOString();

  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;

    const set: Partial<TxRow> = { updatedAt: nowIso };
    if (patch.amountPaise !== undefined) set.amountPaise = fxPrimaryAmount ?? patch.amountPaise;
    if (fxRate) {
      set.fxRateScaled = fxRate.scaled;
      set.fxScale = fxRate.scale;
    }
    if (patch.notes !== undefined) set.notes = patch.notes?.trim() ? patch.notes.trim() : null;
    if (patch.categoryId !== undefined && categoryLeg === row) set.categoryId = patch.categoryId;
    if (newPayeeId !== undefined) set.payeeId = newPayeeId;
    if (patch.date !== undefined && patch.date !== row.date) {
      set.date = patch.date;
      set.sequence = nextSequenceOn(txDb, row.accountId, patch.date);
    }

    const res = tx
      .update(schema.transactions)
      .set(set)
      .where(
        and(
          eq(schema.transactions.id, id),
          eq(schema.transactions.updatedAt, expectedUpdatedAt),
          isNull(schema.transactions.deletedAt),
        ),
      )
      .run();
    // Zero rows changed → a concurrent writer moved it first. Throwing here rolls
    // the transaction back (no partial write) and re-throws StaleEditError to the
    // caller (better-sqlite3 re-throws the callback's error after rollback).
    if (res.changes !== 1) throw new StaleEditError();

    // A payee set in place joins the payee list and suggestions, and its category becomes the
    // one remembered for it, as a new row's do (createTransaction).
    const payeeId = newPayeeId ?? (patch.categoryId != null ? row.payeeId : null);
    if (payeeId) {
      upsertPayeeProjections(txDb, {
        accountId: row.accountId,
        userId: actor.userId,
        payeeId,
        categoryId: patch.categoryId !== undefined ? patch.categoryId : row.categoryId,
        nowIso,
      });
    }

    // Sync the partner leg (amount mirror, date/notes copy) for a transfer the actor sees whole.
    if (isTransfer && row.transferPartnerId && !hiddenPartner) {
      const partner = tx
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, row.transferPartnerId))
        .get();
      if (partner) {
        const pset: Partial<TxRow> = { updatedAt: nowIso };
        // Same currency: the partner mirrors (C3). Between currencies: it keeps its amount and
        // takes the re-derived rate.
        if (fxRate) {
          pset.fxRateScaled = fxRate.scaled;
          pset.fxScale = fxRate.scale;
        } else if (patch.amountPaise !== undefined) pset.amountPaise = -patch.amountPaise;
        if (patch.notes !== undefined) pset.notes = set.notes ?? null;
        if (patch.categoryId !== undefined && categoryLeg !== row) pset.categoryId = patch.categoryId;
        if (patch.date !== undefined && patch.date !== partner.date) {
          pset.date = patch.date;
          pset.sequence = nextSequenceOn(txDb, partner.accountId, patch.date);
        }
        // Only when something on it changes: a stamp alone would tell its other viewers when this
        // leg was touched, and make their open page's next edit stale (P4D).
        if (Object.keys(pset).length > 1) tx.update(schema.transactions).set(pset).where(eq(schema.transactions.id, partner.id)).run();
        // The partner leg lives on the OTHER account (a contribution INTO a
        // holding) — re-derive its marks too (S3 RD1). Self-gated.
        reconcileMarks(txDb, partner.accountId, nowIso);
      }
    }

    // Editing an amount/date on this row (a contribution or a mark itself) shifts
    // running balances → re-derive this account's marks (S3 RD1). Self-gated.
    reconcileMarks(txDb, row.accountId, nowIso);
  });

  return { updatedAt: nowIso };
}

/** Thrown when a row can't move to the account asked (the message says why, in plain words). */
export class MoveTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveTransactionError';
  }
}

/**
 * Move a row to another account: All transactions' Account cell (as
 * Actual's All accounts register: any row but a split child, withdrawal or deposit, a transfer's
 * leg too). The row keeps its date, amount, payee, memo and author and takes the next sequence on
 * its date in the new account; balances follow (derived on read).
 *
 * Refused, in plain words: a value update (it belongs to its holding), a closed account either
 * side, an account the actor can't see (P0: the not-found error, as everywhere), another currency
 * (the amount is in this account's money), a transfer's leg onto its own other side, and a transfer
 * whose other side the actor can't see (they never rewrite it).
 *
 * Category: an ordinary row keeps its own (categorised rows on holdings
 * count, so EPF's Salary row moved off the bank is still income); a transfer keeps
 * its category on whichever leg now takes one (`transferTakesCategory`), or loses it.
 */
export async function moveTransaction(
  database: Db,
  actor: { readonly userId: string },
  id: string,
  targetAccountId: string,
  expectedUpdatedAt: string,
): Promise<{ updatedAt: string }> {
  const { db } = database;
  const row = await requireVisibleTx(db, actor.userId, id);
  if (row.accountId === targetAccountId) return { updatedAt: row.updatedAt };
  if (row.kind === 'valuationMark') throw new MoveTransactionError('A value update stays on its account');
  if (!(await isAccountVisibleTo(db, actor.userId, targetAccountId))) throw new AccountNotFoundError();
  requireHeldDate(db, actor.userId, targetAccountId, row.date);
  requireOpen(db, row.accountId);
  requireOpen(db, targetAccountId);
  const accounts = db
    .select({ id: schema.accounts.id, currency: schema.accounts.currency, type: schema.accounts.type, deletedAt: schema.accounts.deletedAt })
    .from(schema.accounts)
    .where(inArray(schema.accounts.id, [row.accountId, targetAccountId]))
    .all();
  const from = accounts.find((a) => a.id === row.accountId);
  const to = accounts.find((a) => a.id === targetAccountId);
  if (!from || !to || to.deletedAt !== null) throw new AccountNotFoundError();
  if (from.currency !== to.currency) throw new MoveTransactionError(`Only to an account in ${from.currency}`);

  const partnerRow = row.transferPartnerId
    ? db.select().from(schema.transactions).where(eq(schema.transactions.id, row.transferPartnerId)).get()
    : undefined;
  let partnerType = '';
  if (partnerRow) {
    if (!(await canWriteHalf(db, actor.userId, partnerRow))) {
      throw await hiddenHalfError(db, row, partnerRow, actor.userId);
    }
    if (partnerRow.accountId === targetAccountId) throw new MoveTransactionError('That is the other side of this transfer');
    requireOpen(db, partnerRow.accountId);
    partnerType = accountTypes(db, [partnerRow.accountId]).get(partnerRow.accountId) ?? '';
  }

  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    const set: Partial<TxRow> = {
      accountId: targetAccountId,
      sequence: nextSequenceOn(txDb, targetAccountId, row.date),
      updatedAt: nowIso,
    };
    let partnerCategory: string | null | undefined;
    if (partnerRow) {
      // The transfer's one category belongs on its spending-side leg, if the new pair takes one.
      const category = row.categoryId ?? partnerRow.categoryId;
      if (!transferTakesCategory(to.type, partnerType)) {
        set.categoryId = null;
        partnerCategory = null;
      } else if (categoryLegOf('self', to.type, 'partner') === 'self') {
        set.categoryId = category;
        partnerCategory = null;
      } else {
        set.categoryId = null;
        partnerCategory = category;
      }
    }

    const res = tx
      .update(schema.transactions)
      .set(set)
      .where(and(eq(schema.transactions.id, id), eq(schema.transactions.updatedAt, expectedUpdatedAt), isNull(schema.transactions.deletedAt)))
      .run();
    if (res.changes !== 1) throw new StaleEditError();
    if (partnerRow && partnerCategory !== undefined && partnerCategory !== partnerRow.categoryId) {
      tx.update(schema.transactions).set({ categoryId: partnerCategory, updatedAt: nowIso }).where(eq(schema.transactions.id, partnerRow.id)).run();
    }

    // The payee now shows for the new account's viewers (its suggestions and the Payees page).
    if (row.payeeId) {
      upsertPayeeProjections(txDb, {
        accountId: targetAccountId,
        userId: actor.userId,
        payeeId: row.payeeId,
        categoryId: set.categoryId === undefined ? row.categoryId : set.categoryId,
        nowIso,
      });
    }
    // Both balances changed under any later value updates: re-derive them (S3 RD1). Self-gated.
    reconcileMarks(txDb, row.accountId, nowIso);
    reconcileMarks(txDb, targetAccountId, nowIso);
  });
  return { updatedAt: nowIso };
}

/** Thrown when a payee-cell edit can't re-pair a transfer (the message says why, in plain words). */
export class TransferEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferEditError';
  }
}

/**
 * A member can't change
 * the half of a transfer they can't see. Its amount, date, delete, duplicate and re-pair are
 * refused (an edit needs write access to every ledger it touches); its memo edits their own leg
 * only. The message names who entered the row, a name the row already shows ("From Alice").
 */
export class HiddenTransferError extends TransferEditError {
  constructor(who: string | null, message?: string) {
    super(message ?? `The other half of this transfer is in an account you can't see. Ask ${who ?? "the account's owner"} to change it.`);
    this.name = 'HiddenTransferError';
  }
}

/**
 * N-18 (H3 RD8, H4 RD8): the other half of a transfer sits in an account whose owner has left the
 * Circle. Nobody holds that account now (H3 blocks removing the owner of a shared account) and
 * nobody ever will, so the half can never be changed by anyone: returns that person's name, or null.
 */
function partnerOwnerLeft(db: AppDb, partnerAccountId: string): string | null {
  const r = db
    .select({ name: schema.users.displayName, deletedAt: schema.users.deletedAt })
    .from(schema.accounts)
    .innerJoin(schema.users, eq(schema.users.id, schema.accounts.ownerId))
    .where(eq(schema.accounts.id, partnerAccountId))
    .get();
  return r && r.deletedAt !== null ? r.name : null;
}

/**
 * N-18: unlink `row` from its other half in the account of someone who left the Circle, so the
 * actor can change or delete their own half: it becomes a plain row with the payee "Bob (left)"
 * (its category stays). The other half stays, unlinked, in the departed member's account, which
 * nobody can see again, so changing this one reveals nothing. Optimistic on the row; returns the
 * row's new `updatedAt`.
 */
async function unlinkFromLeft(db: AppDb, row: TxRow, expectedUpdatedAt: string, name: string, userId: string): Promise<string> {
  const payee = await resolvePayee(db, `${name} (left)`);
  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    const res = tx
      .update(schema.transactions)
      .set({ transferPartnerId: null, payeeId: payee.id, fxRateScaled: null, fxScale: null, updatedAt: nowIso })
      .where(and(eq(schema.transactions.id, row.id), eq(schema.transactions.updatedAt, expectedUpdatedAt), isNull(schema.transactions.deletedAt)))
      .run();
    if (res.changes === 0) throw new StaleEditError();
    tx.update(schema.transactions)
      .set({ transferPartnerId: null, updatedAt: nowIso })
      .where(eq(schema.transactions.id, row.transferPartnerId!))
      .run();
    upsertPayeeProjections(tx as unknown as AppDb, { accountId: row.accountId, userId, payeeId: payee.id, categoryId: row.categoryId, nowIso });
  });
  return nowIso;
}

/**
 * The refusal for a transfer half the actor can't write. When they can still read its account
 * (they held it once; C5 C, N-17) it says so and names the account's owner; otherwise it is
 * the general refusal, naming who entered the row.
 */
async function hiddenHalfError(db: AppDb, row: TxRow, partner: { accountId: string }, actorId: string): Promise<HiddenTransferError> {
  if (await isAccountReadableBy(db, actorId, partner.accountId)) {
    const acct = db
      .select({ name: schema.accounts.name, owner: schema.users.displayName })
      .from(schema.accounts)
      .innerJoin(schema.users, eq(schema.users.id, schema.accounts.ownerId))
      .where(eq(schema.accounts.id, partner.accountId))
      .get();
    if (acct) {
      return new HiddenTransferError(null, `The other half of this transfer is in ${acct.name}, which is no longer shared with you. Ask ${acct.owner} to change it.`);
    }
  }
  return new HiddenTransferError(whoCanChange(db, row, actorId));
}

/** `(accountId, date) => may the actor write a row there`, for a batch (C5 C: held now, that day). */
async function writableTest(db: AppDb, userId: string): Promise<(accountId: string, date: string) => boolean> {
  const visible = await accountsVisibleTo(db, userId);
  const stretches = viewerStretches(db, userId, visible);
  return (accountId, date) => inStretches(stretches.get(accountId) ?? [], date);
}

/** The person to ask about a transfer `actorId` can't fully see: who entered it, unless that's them. */
function whoCanChange(db: AppDb, row: TxRow, actorId: string): string | null {
  if (!row.enteredBy || row.enteredBy === actorId) return null;
  return db.select({ name: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, row.enteredBy)).get()?.name ?? null;
}

/** The other leg of a transfer, which the actor must see and which must sit in an open account. */
async function editablePartner(db: AppDb, userId: string, row: TxRow): Promise<TxRow> {
  const partner = db.select().from(schema.transactions).where(eq(schema.transactions.id, row.transferPartnerId!)).get();
  if (!partner) throw new AccountNotFoundError();
  if (!(await canWriteHalf(db, userId, partner))) throw await hiddenHalfError(db, row, partner, userId);
  requireOpen(db, partner.accountId);
  return partner;
}

/**
 * The payee cell of a row set to an account (Actual: a transfer's payee is the other account):
 * a transfer moves its other leg to `accountId`; an ordinary row becomes a transfer with a new
 * leg there (equal and opposite; payee cleared, and its category too unless the new pair takes
 * one and this row is its spending side). Same currency only: a transfer
 * between currencies carries a rate the transfer form asks for. Optimistic on the row.
 */
export async function setTransferAccount(
  database: Db,
  actor: { readonly userId: string },
  id: string,
  accountId: string,
  expectedUpdatedAt: string,
): Promise<{ updatedAt: string }> {
  const { db } = database;
  const row = await requireVisibleTx(db, actor.userId, id);
  if (row.kind !== 'ordinary') throw new TransferEditError("A value update can't become a transfer");
  requireOpen(db, row.accountId);
  if (accountId === row.accountId) throw new TransferEditError("A transfer can't go to its own account");
  if (!(await isAccountVisibleTo(db, actor.userId, accountId))) throw new AccountNotFoundError();
  requireHeldDate(db, actor.userId, accountId, row.date);
  const accts = db
    .select({ id: schema.accounts.id, type: schema.accounts.type, currency: schema.accounts.currency, status: schema.accounts.status })
    .from(schema.accounts)
    .where(and(inArray(schema.accounts.id, [row.accountId, accountId]), isNull(schema.accounts.deletedAt)))
    .all();
  const self = accts.find((a) => a.id === row.accountId);
  const target = accts.find((a) => a.id === accountId);
  if (!self || !target) throw new AccountNotFoundError();
  if (target.status !== 'open') throw new ClosedAccountError();
  const nowIso = new Date().toISOString();
  // The new pair's category (C3): kept on its spending-side leg if the new pair takes one.
  const newPairTakes = transferTakesCategory(self.type, target.type);
  const rowIsCategoryLeg = isSpendingType(self.type);

  if (row.transferPartnerId) {
    const partner = await editablePartner(db, actor.userId, row);
    if (partner.accountId === accountId) return { updatedAt: row.updatedAt };
    if (row.fxRateScaled !== null || target.currency !== self.currency) {
      throw new TransferEditError(`A transfer between currencies needs its amounts in both: delete this one and add it again`);
    }
    const category = row.categoryId ?? partner.categoryId;
    db.transaction((tx) => {
      const txDb = tx as unknown as AppDb;
      const res = tx
        .update(schema.transactions)
        .set({ updatedAt: nowIso, categoryId: newPairTakes && rowIsCategoryLeg ? category : null })
        .where(and(eq(schema.transactions.id, id), eq(schema.transactions.updatedAt, expectedUpdatedAt), isNull(schema.transactions.deletedAt)))
        .run();
      if (res.changes !== 1) throw new StaleEditError();
      tx.update(schema.transactions)
        .set({
          accountId,
          sequence: nextSequenceOn(txDb, accountId, partner.date),
          categoryId: newPairTakes && !rowIsCategoryLeg ? category : null,
          updatedAt: nowIso,
        })
        .where(eq(schema.transactions.id, partner.id))
        .run();
      reconcileMarks(txDb, partner.accountId, nowIso);
      reconcileMarks(txDb, accountId, nowIso);
    });
    return { updatedAt: nowIso };
  }

  if (target.currency !== self.currency) {
    throw new TransferEditError(`A transfer to an account in ${target.currency} needs both amounts: add it as a new transfer`);
  }
  const partnerId = randomUUID();
  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    const res = tx
      .update(schema.transactions)
      .set({ payeeId: null, categoryId: newPairTakes && rowIsCategoryLeg ? row.categoryId : null, updatedAt: nowIso })
      .where(and(eq(schema.transactions.id, id), eq(schema.transactions.updatedAt, expectedUpdatedAt), isNull(schema.transactions.deletedAt)))
      .run();
    if (res.changes !== 1) throw new StaleEditError();
    tx.insert(schema.transactions)
      .values({
        id: partnerId,
        accountId,
        date: row.date,
        sequence: nextSequenceOn(txDb, accountId, row.date),
        amountPaise: -row.amountPaise,
        transferPartnerId: id,
        enteredBy: actor.userId,
        kind: 'ordinary',
        notes: row.notes,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();
    tx.update(schema.transactions).set({ transferPartnerId: partnerId }).where(eq(schema.transactions.id, id)).run();
    reconcileMarks(txDb, row.accountId, nowIso);
    reconcileMarks(txDb, accountId, nowIso);
  });
  return { updatedAt: nowIso };
}

/**
 * A transfer's payee cell set to a payee (Actual): the row becomes an ordinary one with that
 * payee, keeping its own category (a spending-side leg's), and its other leg is deleted (the
 * money no longer arrives there).
 */
export async function transferToPayee(
  database: Db,
  actor: { readonly userId: string },
  id: string,
  payeeName: string,
  expectedUpdatedAt: string,
): Promise<{ updatedAt: string }> {
  const { db } = database;
  const row = await requireVisibleTx(db, actor.userId, id);
  if (!row.transferPartnerId) throw new TransferEditError('Not a transfer');
  requireOpen(db, row.accountId);
  const partner = await editablePartner(db, actor.userId, row);
  // A cleared payee makes it an ordinary row with no payee (C4: "clearing it converts back").
  const payee = payeeName.trim() === '' ? null : await resolvePayee(db, payeeName);
  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    const res = tx
      .update(schema.transactions)
      .set({ transferPartnerId: null, fxRateScaled: null, fxScale: null, payeeId: payee?.id ?? null, updatedAt: nowIso })
      .where(and(eq(schema.transactions.id, id), eq(schema.transactions.updatedAt, expectedUpdatedAt), isNull(schema.transactions.deletedAt)))
      .run();
    if (res.changes !== 1) throw new StaleEditError();
    tx.update(schema.transactions)
      .set({ transferPartnerId: null, deletedAt: nowIso, updatedAt: nowIso })
      .where(eq(schema.transactions.id, partner.id))
      .run();
    if (payee) upsertPayeeProjections(txDb, { accountId: row.accountId, userId: actor.userId, payeeId: payee.id, categoryId: null, nowIso });
    reconcileMarks(txDb, partner.accountId, nowIso);
    reconcileMarks(txDb, row.accountId, nowIso);
  });
  return { updatedAt: nowIso };
}

/**
 * Soft-delete a transaction (tombstone). A TRANSFER deletes BOTH legs atomically
 * (never an orphaned half). Optimistic: the primary row must still match
 * `expectedUpdatedAt`. Returns the ids tombstoned (for an undo affordance).
 */
export async function deleteTransaction(
  database: Db,
  actor: { readonly userId: string },
  id: string,
  expectedUpdatedAt: string,
): Promise<{ deletedIds: string[] }> {
  const { db } = database;
  const row = await requireVisibleTx(db, actor.userId, id);
  requireOpen(db, row.accountId);
  if (row.transferPartnerId) {
    const p = db.select().from(schema.transactions).where(eq(schema.transactions.id, row.transferPartnerId)).get();
    // Deleting would delete the other half too, in an account the actor can't see.
    if (p && !(await canWriteHalf(db, actor.userId, p))) {
      // N-18: unless its holder has left the Circle: then the actor deletes their own half alone.
      const left = partnerOwnerLeft(db, p.accountId);
      if (left !== null) {
        const token = await unlinkFromLeft(db, row, expectedUpdatedAt, left, actor.userId);
        return deleteTransaction(database, actor, id, token);
      }
      throw await hiddenHalfError(db, row, p, actor.userId);
    }
    if (p) requireOpen(db, p.accountId);
  }
  const nowIso = new Date().toISOString();
  const deletedIds: string[] = [];

  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    const res = tx
      .update(schema.transactions)
      .set({ deletedAt: nowIso, updatedAt: nowIso })
      .where(
        and(
          eq(schema.transactions.id, id),
          eq(schema.transactions.updatedAt, expectedUpdatedAt),
          isNull(schema.transactions.deletedAt),
        ),
      )
      .run();
    // Roll back + re-throw StaleEditError on a concurrent change (see updateTransaction).
    if (res.changes !== 1) throw new StaleEditError();
    deletedIds.push(id);
    if (row.transferPartnerId) {
      const partner = tx
        .select({ accountId: schema.transactions.accountId })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, row.transferPartnerId))
        .get();
      tx.update(schema.transactions)
        .set({ deletedAt: nowIso, updatedAt: nowIso })
        .where(
          and(
            eq(schema.transactions.id, row.transferPartnerId),
            isNull(schema.transactions.deletedAt),
          ),
        )
        .run();
      deletedIds.push(row.transferPartnerId);
      // Removing a contribution shifts the OTHER account's balance too (S3 RD1).
      if (partner) reconcileMarks(txDb, partner.accountId, nowIso);
    }

    // Removing a row (a contribution or a mark) shifts running balances → the
    // account's remaining marks re-derive (S3 RD1). Self-gated.
    reconcileMarks(txDb, row.accountId, nowIso);
  });

  return { deletedIds };
}

/**
 * Undo a delete: clear the tombstone. A transfer restores BOTH legs as a pair
 * (C4 RD1). Idempotent-ish: restoring a live row is a no-op. The (date, sequence)
 * slot was never reissued (nextSequenceOn counts tombstones), so a restore never
 * collides with a row created after the delete.
 */
export async function restoreTransaction(
  database: Db,
  actor: { readonly userId: string },
  id: string,
): Promise<void> {
  const { db } = database;
  const row = db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, id))
    .get();
  if (!row) throw new AccountNotFoundError();
  if (!(await canWriteOn(db, actor.userId, row.accountId, row.date))) throw new AccountNotFoundError();
  // A live row has nothing to restore (P4D: a restore of one rewrote its hidden partner's stamp).
  if (row.deletedAt === null) return;
  // The other half in an account the actor can't see is never brought back by them
  // (the same not-found as a bogus id); only someone who sees both can undo such a delete.
  if (row.transferPartnerId) {
    const p = db.select({ accountId: schema.transactions.accountId, date: schema.transactions.date }).from(schema.transactions).where(eq(schema.transactions.id, row.transferPartnerId)).get();
    if (p && !(await canWriteHalf(db, actor.userId, p))) throw new AccountNotFoundError();
    if (p) requireOpen(db, p.accountId, CLOSED_CHANGE);
  }
  // An Undo after the close would put money back on a closed account.
  requireOpen(db, row.accountId, CLOSED_CHANGE);

  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    tx.update(schema.transactions)
      .set({ deletedAt: null, updatedAt: nowIso })
      .where(eq(schema.transactions.id, id))
      .run();
    if (row.transferPartnerId) {
      const partner = tx
        .select({ accountId: schema.transactions.accountId })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, row.transferPartnerId))
        .get();
      tx.update(schema.transactions)
        .set({ deletedAt: null, updatedAt: nowIso })
        .where(eq(schema.transactions.id, row.transferPartnerId))
        .run();
      if (partner) reconcileMarks(txDb, partner.accountId, nowIso);
    }
    // Restoring a contribution/mark re-shifts balances → re-derive (S3 RD1).
    reconcileMarks(txDb, row.accountId, nowIso);
  });
}

/**
 * Undo a BULK delete (C4 AC "Undo restores the last delete — single or bulk";
 * REL-03): clear the tombstones of every given row AND its transfer partner, in
 * ONE db transaction (all-or-nothing, like the bulk delete it reverses). Every
 * row must be on an account the actor can see — otherwise nothing is restored
 * (AccountNotFoundError, the same not-found shape as a single restore).
 */
export async function restoreTransactions(
  database: Db,
  actor: { readonly userId: string },
  ids: readonly string[],
): Promise<{ restored: number }> {
  const { db } = database;
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { restored: 0 };
  const all = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      transferPartnerId: schema.transactions.transferPartnerId,
      deletedAt: schema.transactions.deletedAt,
      date: schema.transactions.date,
    })
    .from(schema.transactions)
    .where(inArray(schema.transactions.id, unique))
    .all();
  const writable = await writableTest(db, actor.userId);
  if (all.length !== unique.length || all.some((r) => !writable(r.accountId, r.date))) {
    throw new AccountNotFoundError();
  }
  // A pair whose other half the actor can't see is never theirs to restore.
  const partnerIds = all.map((r) => r.transferPartnerId).filter((x): x is string => x !== null);
  if (partnerIds.length > 0) {
    const partners = db.select({ accountId: schema.transactions.accountId, date: schema.transactions.date }).from(schema.transactions).where(inArray(schema.transactions.id, partnerIds)).all();
    if (partners.some((p) => !writable(p.accountId, p.date))) throw new AccountNotFoundError();
    for (const p of partners) requireOpen(db, p.accountId, CLOSED_CHANGE);
  }
  // All or nothing, as the delete was: one row on a closed account refuses the whole Undo.
  for (const accountId of new Set(all.map((r) => r.accountId))) requireOpen(db, accountId, CLOSED_CHANGE);
  // Live rows have nothing to restore.
  const rows = all.filter((r) => r.deletedAt !== null);

  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    const touched = new Set<string>();
    for (const r of rows) {
      tx.update(schema.transactions)
        .set({ deletedAt: null, updatedAt: nowIso })
        .where(eq(schema.transactions.id, r.id))
        .run();
      touched.add(r.accountId);
      if (r.transferPartnerId) {
        const partner = tx
          .select({ accountId: schema.transactions.accountId })
          .from(schema.transactions)
          .where(eq(schema.transactions.id, r.transferPartnerId))
          .get();
        tx.update(schema.transactions)
          .set({ deletedAt: null, updatedAt: nowIso })
          .where(eq(schema.transactions.id, r.transferPartnerId))
          .run();
        if (partner) touched.add(partner.accountId);
      }
    }
    // Restored contributions/marks re-shift balances → re-derive once (S3 RD1).
    for (const accountId of touched) reconcileMarks(txDb, accountId, nowIso);
  });
  return { restored: rows.length };
}

/** Thrown when a row can't be duplicated (the message says why, in plain words). */
export class DuplicateTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateTransactionError';
  }
}

/**
 * Duplicate a transaction (C4 RD2) — a fresh ordinary row on the same date,
 * copying payee/category/amount/notes, with the next sequence. A transfer
 * duplicates as a new linked pair between the same two accounts (a one-legged copy
 * was an unlinked, uncategorized expense or income). A value update is refused: its
 * copy would be an ordinary row of the same amount, counting its gain a second time.
 * Returns the new row id.
 */
export async function duplicateTransaction(
  database: Db,
  actor: { readonly userId: string },
  id: string,
): Promise<{ id: string }> {
  const { db } = database;
  const row = await requireVisibleTx(db, actor.userId, id);
  if (row.kind === 'valuationMark') {
    throw new DuplicateTransactionError("A value update can't be duplicated. Use Update value to change the value.");
  }
  requireOpen(db, row.accountId);
  const newId = randomUUID();
  const nowIso = new Date().toISOString();
  if (row.transferPartnerId) {
    const partner = db.select().from(schema.transactions).where(eq(schema.transactions.id, row.transferPartnerId)).get();
    if (!partner) throw new AccountNotFoundError();
    // A copy would write a new leg into an account the actor can't see.
    if (!(await canWriteHalf(db, actor.userId, partner))) throw await hiddenHalfError(db, row, partner, actor.userId);
    requireOpen(db, partner.accountId);
    const partnerId = randomUUID();
    db.transaction((tx) => {
      const txDb = tx as unknown as AppDb;
      const leg = (legId: string, src: TxRow, partnerOf: string | null) =>
        tx.insert(schema.transactions)
          .values({
            id: legId,
            accountId: src.accountId,
            date: src.date,
            sequence: nextSequenceOn(txDb, src.accountId, src.date),
            amountPaise: src.amountPaise,
            transferPartnerId: partnerOf,
            enteredBy: actor.userId,
            kind: 'ordinary',
            notes: src.notes,
            categoryId: src.categoryId,
            fxRateScaled: src.fxRateScaled,
            fxScale: src.fxScale,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
          .run();
      leg(newId, row, null);
      leg(partnerId, partner, newId);
      tx.update(schema.transactions).set({ transferPartnerId: partnerId }).where(eq(schema.transactions.id, newId)).run();
      reconcileMarks(txDb, row.accountId, nowIso);
      reconcileMarks(txDb, partner.accountId, nowIso);
    });
    return { id: newId };
  }
  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    const sequence = nextSequenceOn(txDb, row.accountId, row.date);
    tx.insert(schema.transactions)
      .values({
        id: newId,
        accountId: row.accountId,
        date: row.date,
        sequence,
        amountPaise: row.amountPaise,
        categoryId: row.categoryId,
        payeeId: row.payeeId,
        enteredBy: actor.userId,
        kind: 'ordinary',
        notes: row.notes,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();
    reconcileMarks(txDb, row.accountId, nowIso);
  });
  return { id: newId };
}

/**
 * Move a row up/down among its SAME-DATE siblings by swapping `sequence` with the
 * adjacent row (C4 reorder; the drag/up-down UI both call this). Only reassigns
 * sequence WITHIN the date — never changes the date. A no-op at the boundary.
 */
export async function reorderWithinDate(
  database: Db,
  actor: { readonly userId: string },
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  const { db } = database;
  const row = await requireVisibleTx(db, actor.userId, id);
  // A swap past the closing row re-derives a mark after it, so a closed account moved.
  requireOpen(db, row.accountId, CLOSED_CHANGE);

  // "up" in the passbook (newer) = the next-higher sequence on the same date.
  const siblings = db
    .select({ id: schema.transactions.id, sequence: schema.transactions.sequence })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.accountId, row.accountId),
        eq(schema.transactions.date, row.date),
        isNull(schema.transactions.deletedAt),
      ),
    )
    .orderBy(asc(schema.transactions.sequence))
    .all();
  const idx = siblings.findIndex((s) => s.id === id);
  const swapIdx = direction === 'up' ? idx + 1 : idx - 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return; // boundary → no-op

  const a = siblings[idx]!;
  const b = siblings[swapIdx]!;
  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    // Two-step swap via a temporary sentinel to avoid a transient (date,sequence)
    // clash (the index is not UNIQUE, but keep the slots clean regardless).
    tx.update(schema.transactions).set({ sequence: -1, updatedAt: nowIso }).where(eq(schema.transactions.id, a.id)).run();
    tx.update(schema.transactions).set({ sequence: a.sequence, updatedAt: nowIso }).where(eq(schema.transactions.id, b.id)).run();
    tx.update(schema.transactions).set({ sequence: b.sequence, updatedAt: nowIso }).where(eq(schema.transactions.id, a.id)).run();
    // A mark sitting between the swapped rows re-derives its gap (S3 RD1).
    reconcileMarks(txDb, row.accountId, nowIso);
  });
}

export type BulkAction =
  | { readonly kind: 'setCategory'; readonly categoryId: string | null }
  | { readonly kind: 'setNotes'; readonly notes: string | null }
  | { readonly kind: 'delete' };

/**
 * Apply a bulk action to many transactions ATOMICALLY (all-or-nothing — never a
 * half-applied batch). Only rows the actor can see are touched. For setCategory, a value update
 * is left as it is (L12), and
 * a transfer that takes a category gets it on its spending-side leg; any other transfer (and
 * one whose other half the actor can't write, S19) is skipped and counted so the UI can report it. Returns how many rows were affected and how many were skipped,
 * and — for a delete — the ids it tombstoned, so the UI can offer Undo
 * (`restoreTransactions`).
 */
export async function bulkUpdate(
  database: Db,
  actor: { readonly userId: string },
  ids: readonly string[],
  action: BulkAction,
): Promise<{ affected: number; skippedTransfers: number; skippedHidden: number; deletedIds: string[] }> {
  const { db } = database;
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { affected: 0, skippedTransfers: 0, skippedHidden: 0, deletedIds: [] };

  // Validate a target category once (shared predicate with createTransaction).
  if (action.kind === 'setCategory' && action.categoryId !== null) {
    if (!isPickableCategory(db, action.categoryId)) throw new InvalidCategoryError();
  }

  const writable = await writableTest(db, actor.userId);
  let rows = db
    .select()
    .from(schema.transactions)
    .where(and(inArray(schema.transactions.id, unique), isNull(schema.transactions.deletedAt)))
    .all()
    .filter((r) => writable(r.accountId, r.date));
  // Rows in a closed account (or a transfer whose other side is in one) stay as they are, but for
  // an ordinary row's category (C4 RD8: it moves no money, and To categorize clears).
  const closed = new Set(
    db.select({ id: schema.accounts.id }).from(schema.accounts).where(sql`${schema.accounts.status} <> 'open'`).all().map((a) => a.id),
  );
  if (closed.size > 0) {
    const partnerAcct = new Map(
      db
        .select({ id: schema.transactions.id, accountId: schema.transactions.accountId })
        .from(schema.transactions)
        .where(inArray(schema.transactions.id, rows.map((r) => r.transferPartnerId).filter((x): x is string => x !== null)))
        .all()
        .map((p) => [p.id, p.accountId]),
    );
    const categoryOnly = (r: TxRow) => action.kind === 'setCategory' && r.transferPartnerId === null && r.kind === 'ordinary';
    rows = rows.filter(
      (r) =>
        (!closed.has(r.accountId) || categoryOnly(r)) &&
        !(r.transferPartnerId && closed.has(partnerAcct.get(r.transferPartnerId) ?? '')),
    );
  }

  const nowIso = new Date().toISOString();
  let affected = 0;
  let skippedTransfers = 0;
  const deletedIds: string[] = [];

  // For a category: each transfer's other leg (its account decides whether the pair takes one,
  // and the category sits on the spending-side leg, which the actor must see). For a delete: a
  // transfer whose other half the actor can't see stays, counted in `skippedHidden`.
  let skippedHidden = 0;
  const partners = new Map(
    action.kind !== 'setNotes'
      ? db
          .select({ id: schema.transactions.id, accountId: schema.transactions.accountId, date: schema.transactions.date })
          .from(schema.transactions)
          .where(inArray(schema.transactions.id, rows.map((r) => r.transferPartnerId).filter((x): x is string => x !== null)))
          .all()
          .map((p) => [p.id, p])
      : [],
  );
  const types = accountTypes(db, [...rows.map((r) => r.accountId), ...[...partners.values()].map((p) => p.accountId)]);
  const categorised = new Set<string>();

  db.transaction((tx) => {
    const txDb = tx as unknown as AppDb;
    // Accounts whose running balance a DELETE shifted → reconcile once at the end
    // (S3 RD1). setCategory/setNotes leave amounts untouched, so no reconcile.
    const touched = new Set<string>();
    for (const r of rows) {
      if (action.kind === 'setCategory') {
        // A value update takes no category, as its register cell says (L12).
        if (r.kind !== 'ordinary') continue;
        let targetId = r.id;
        if (r.transferPartnerId !== null) {
          const p = partners.get(r.transferPartnerId);
          const selfType = types.get(r.accountId) ?? '';
          // A transfer whose other half the actor can't write is skipped before its type is
          // read, so the answer is the same whatever kind of account is hidden (S19).
          if (!p || !writable(p.accountId, p.date) || !transferTakesCategory(selfType, types.get(p.accountId) ?? '')) {
            skippedTransfers++;
            continue;
          }
          const leg = categoryLegOf({ id: r.id, accountId: r.accountId, date: r.date }, selfType, p);
          if (!writable(leg.accountId, r.date)) {
            skippedTransfers++;
            continue;
          }
          targetId = leg.id;
        }
        if (categorised.has(targetId)) continue; // both legs of one transfer were selected
        categorised.add(targetId);
        tx.update(schema.transactions)
          .set({ categoryId: action.categoryId, updatedAt: nowIso })
          .where(eq(schema.transactions.id, targetId))
          .run();
        affected++;
      } else if (action.kind === 'setNotes') {
        tx.update(schema.transactions)
          .set({ notes: action.notes?.trim() ? action.notes.trim() : null, updatedAt: nowIso })
          .where(eq(schema.transactions.id, r.id))
          .run();
        affected++;
      } else {
        // delete — tombstone this row and, for a transfer, its partner too.
        const p = r.transferPartnerId ? partners.get(r.transferPartnerId) : undefined;
        if (p && !writable(p.accountId, p.date)) {
          skippedHidden++;
          continue;
        }
        tx.update(schema.transactions)
          .set({ deletedAt: nowIso, updatedAt: nowIso })
          .where(eq(schema.transactions.id, r.id))
          .run();
        affected++;
        deletedIds.push(r.id);
        touched.add(r.accountId);
        if (r.transferPartnerId) {
          const partner = tx
            .select({ accountId: schema.transactions.accountId })
            .from(schema.transactions)
            .where(eq(schema.transactions.id, r.transferPartnerId))
            .get();
          tx.update(schema.transactions)
            .set({ deletedAt: nowIso, updatedAt: nowIso })
            .where(
              and(
                eq(schema.transactions.id, r.transferPartnerId),
                isNull(schema.transactions.deletedAt),
              ),
            )
            .run();
          if (partner) touched.add(partner.accountId);
        }
      }
    }
    for (const accountId of touched) reconcileMarks(txDb, accountId, nowIso);
  });

  return { affected, skippedTransfers, skippedHidden, deletedIds };
}

// ============================================================================
// C5 — the "To categorize" inbox. Pure DERIVED membership (no stored flag): an
// uncategorized, non-transfer ORDINARY row in a SPENDING account the viewer can
// see. The seeded Balance-adjustment category keeps force-close rows out (C5
// RD4) with no special-case filter here.
// ============================================================================

export interface InboxRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly date: string;
  readonly amountPaise: number;
  readonly payeeName: string | null;
  readonly notes: string | null;
  readonly updatedAt: string;
  /** F3 remembered-category suggestion for this row's payee (this viewer), IF the
   *  remembered category is still live + non-hidden — the "✦ suggested" affordance
   *  (C5 alt path). Null when the payee has no remembered category. (DEV-16) */
  readonly suggestedCategoryId: string | null;
  readonly suggestedCategoryName: string | null;
}

/** The viewer's open-or-closed spending accounts the inbox reads (module metadata, never `if type===`). */
function inboxAccounts(db: AppDb, visible: readonly string[]): string[] {
  if (visible.length === 0) return [];
  return db
    .select({ id: schema.accounts.id, type: schema.accounts.type })
    .from(schema.accounts)
    .where(inArray(schema.accounts.id, [...visible]))
    .all()
    .filter((a) => isSpendingType(a.type))
    .map((a) => a.id);
}

/** Where an Inbox page ends: the last row's `(date, sequence, id)`, newest first. */
export interface InboxCursor {
  readonly date: string;
  readonly sequence: number;
  readonly id: string;
}

/** The viewer's uncategorized spending rows (the inbox list), newest first. */
export async function inboxTransactions(database: Db, userId: string): Promise<InboxRow[]> {
  return (await inboxPage(database, userId, {})).rows;
}

/**
 * One page of the inbox (it drew every row, 16 MB of HTML at 3,300 rows after an import):
 * up to `limit` rows after `after`, newest first by `(date, sequence, id)`, and where the page
 * ended when more follow. No limit: every row.
 */
export async function inboxPage(
  database: Db,
  userId: string,
  opts: { readonly limit?: number; readonly after?: InboxCursor | null },
): Promise<{ rows: InboxRow[]; next: InboxCursor | null }> {
  const { db } = database;
  const visible = await accountsVisibleTo(db, userId);
  const spending = inboxAccounts(db, visible);
  if (spending.length === 0) return { rows: [], next: null };
  const t = schema.transactions;
  const after = opts.after ?? null;
  const limit = opts.limit;

  const rows = db
    .select({
      id: t.id,
      accountId: t.accountId,
      accountName: schema.accounts.name,
      accountType: schema.accounts.type,
      date: t.date,
      sequence: t.sequence,
      amountPaise: t.amountPaise,
      payeeName: schema.payees.displayName,
      notes: sql<string | null>`substr(${t.notes}, 1, ${LISTED_NOTE_CHARS})`,
      updatedAt: t.updatedAt,
      // DEV-16: this viewer's remembered category for the row's payee (F3), but
      // only when it's still live + non-hidden (the join conditions null it out
      // otherwise, so a suggestion never points at a deleted/hidden category).
      suggestedCategoryId: schema.categories.id,
      suggestedCategoryName: schema.categories.name,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .leftJoin(schema.userPayee, and(eq(schema.userPayee.payeeId, t.payeeId), eq(schema.userPayee.userId, userId)))
    .leftJoin(schema.categories, and(eq(schema.categories.id, schema.userPayee.lastCategoryId), categoryPickable))
    .where(
      and(
        inArray(t.accountId, spending),
        isNull(t.deletedAt),
        isNull(t.categoryId),
        isNull(t.transferPartnerId),
        eq(t.kind, 'ordinary'),
        // C5 C: only rows dated inside the viewer's stretches (a member's from the day they joined).
        heldRowCondition(userId),
        after ? sql`(${t.date}, ${t.sequence}, ${t.id}) < (${after.date}, ${after.sequence}, ${after.id})` : undefined,
      ),
    )
    .orderBy(desc(t.date), desc(t.sequence), desc(t.id))
    .limit(limit === undefined ? -1 : limit + 1)
    .all();
  const more = limit !== undefined && rows.length > limit;
  if (more) rows.length = limit;

  // The inbox's Account column names "HDFC (Bank accounts)" beside an HDFC fund.
  const sameName = sharedNamesOf(db, visible);
  const last = rows[rows.length - 1];
  return {
    rows: rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      accountName: sectionedName({ name: r.accountName, type: r.accountType }, sameName),
      date: r.date,
      amountPaise: r.amountPaise,
      payeeName: r.payeeName ?? null,
      notes: r.notes,
      updatedAt: r.updatedAt,
      suggestedCategoryId: r.suggestedCategoryId ?? null,
      suggestedCategoryName: r.suggestedCategoryName ?? null,
    })),
    next: more && last ? { date: last.date, sequence: last.sequence, id: last.id } : null,
  };
}

/** The Inbox page's header figures without its rows: how many, and how many have a suggestion
 *  (Apply all suggestions). The list's predicate, counted in SQL. */
export async function inboxSummary(database: Db, userId: string): Promise<{ total: number; suggested: number }> {
  const { db } = database;
  const spending = inboxAccounts(db, await accountsVisibleTo(db, userId));
  if (spending.length === 0) return { total: 0, suggested: 0 };
  const t = schema.transactions;
  const row = db
    .select({ total: sql<number>`count(*)`, suggested: sql<number>`count(${schema.categories.id})` })
    .from(t)
    .leftJoin(schema.userPayee, and(eq(schema.userPayee.payeeId, t.payeeId), eq(schema.userPayee.userId, userId)))
    .leftJoin(schema.categories, and(eq(schema.categories.id, schema.userPayee.lastCategoryId), categoryPickable))
    .where(
      and(
        inArray(t.accountId, spending),
        isNull(t.deletedAt),
        isNull(t.categoryId),
        isNull(t.transferPartnerId),
        eq(t.kind, 'ordinary'),
        heldRowCondition(userId),
      ),
    )
    .get();
  return { total: row?.total ?? 0, suggested: row?.suggested ?? 0 };
}

/** The inbox backlog size, the nav badge: the list's predicate, counted in SQL. It built the whole
 *  list (every row with its note) on every page just to count it. */
export async function inboxCount(database: Db, userId: string): Promise<number> {
  const { db } = database;
  const scope = await heldScope(db, userId);
  if (scope.all.length === 0) return 0;
  // Spending-scope filter reads module metadata (never `if type===`), as the list's.
  const spending = db
    .select({ id: schema.accounts.id, type: schema.accounts.type })
    .from(schema.accounts)
    .where(inArray(schema.accounts.id, scope.all))
    .all()
    .filter((a) => isSpendingType(a.type))
    .map((a) => a.id);
  if (spending.length === 0) return 0;
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.deletedAt),
        isNull(schema.transactions.categoryId),
        isNull(schema.transactions.transferPartnerId),
        eq(schema.transactions.kind, 'ordinary'),
        // C5 C: only rows dated inside the viewer's stretches, checked per row only where needed.
        heldRowsIn(scopeOn(scope, spending), userId),
      ),
    )
    .get();
  return row?.n ?? 0;
}
