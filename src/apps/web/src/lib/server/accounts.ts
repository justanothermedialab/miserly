/**
 * accounts.ts — the F1 account lifecycle service (create · close · reopen · list).
 * ============================================================================
 * The lifecycle-critical half of Foundations. Two invariants make this the
 * correctness core (hand-authored, not delegated):
 *
 *  1. Balance is DERIVED, never stored. `createAccount` writes `opening_paise`
 *     (+ its as-of `opening_date`) and posts NO opening transaction — the
 *     running-balance is `opening_paise + Σtx` (balances.ts). The user-facing
 *     "Starting balance" register row is synthesized from `opening_paise`, not a
 *     stored row (F1 Resolved decision 1, reconciled to the frozen schema).
 *  2. A closed account NEVER carries value. `closeAccount` is force-close (M5):
 *     it reads the derived balance and, if non-zero, posts EXACTLY ONE closing
 *     adjustment = `-(balance)` so the derived balance is EXACTLY 0, then flips
 *     status — both in ONE transaction, so there is no window where the account
 *     is closed but still non-zero. (F1's transfer-out-at-close path is a C3
 *     transfer = M6; not built here.)
 *
 * Privacy (P0): a new account stamps `owner_id` = its creator and is private by
 * default (no `account_members` row) — the M4 `accountsVisibleTo` predicate then
 * hides it from everyone else with no extra code. Name-uniqueness is scoped to
 * the OWNER's own open accounts (never Circle-wide): a Circle-wide check would
 * leak, via a "name taken" error, that another member holds an account by that
 * name — a privacy breach. See the uniqueness check below.
 *
 * This service takes the full `Db` (not just the Drizzle handle) because a
 * balance read uses the raw-SQL crown-jewel `accountBalance()` (a better-sqlite3
 * handle) alongside Drizzle mutations — both on the one connection, so a read
 * inside a Drizzle transaction participates in it. R8: functions are async.
 * ============================================================================
 */
import { isRealDate } from '../dates';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { hasModule, today, formatDate, parseDate } from '@miserly/core';
import { appClock } from './clock';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { accountBalance } from './db/balances';
import { ledgerCuts, todayCuts } from './ledger-cuts';
import { accountsVisibleTo, accountsHeldBefore, viewerStretches, SINCE_START } from './visibility';
import { normalizeName } from './names';
import { nextSequenceOn, ClosedAccountError } from './transactions';
import { reconcileMarks, postValuationMark } from './marks';
import { BALANCE_ADJUSTMENT_CATEGORY_ID } from './seed';
import { isSupportedCurrency } from '../currencies';
import { formatDate as formatDisplayDate } from '../dates';
import { moduleProfile } from '../modules';

export interface CreateAccountInput {
  /** The creating member — becomes `owner_id` (private by default). */
  readonly ownerId: string;
  /** Module registry key: any registered module (the 11-module v1 set at M8). */
  readonly type: string;
  readonly name: string;
  readonly currency: string;
  /** Signed opening balance in paise. 0 allowed; negative allowed (liabilities). */
  readonly openingPaise: number;
  /** As-of date 'YYYY-MM-DD' of the opening balance. Required iff openingPaise ≠ 0. */
  readonly openingDate: string | null;
  /** M8: per-module INFORMATIONAL fields (S5) as a JSON string. Display-only. */
  readonly infoJson?: string | null;
  /** Migration 0014: the account this one belongs to (an EPF's EPS, S5 RD16). */
  readonly parentAccountId?: string | null;
}

export interface AccountSummary {
  readonly id: string;
  readonly ownerId: string;
  readonly type: string;
  readonly name: string;
  readonly currency: string;
  readonly status: 'open' | 'closed';
  readonly openingPaise: number;
  readonly openingDate: string | null;
  /** M8: per-module informational fields (S5) as a JSON string, or null. */
  readonly infoJson: string | null;
  /** Derived: opening_paise + Σ live transactions. Never a stored value. */
  readonly balancePaise: number;
}

/** Thrown when a create/reopen would collide with an existing OPEN account name. */
export class AccountNameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountNameConflictError';
  }
}

/**
 * Thrown when `createAccount` is given a currency outside the MC1/MC3 supported
 * list. This is the ONE choke point every creation path funnels through
 * (`createAccount` itself, plus `createHoldingAccount` which calls it) — so the
 * check holds regardless of which route/onboarding shape is used. There is NO
 * currency-edit path anywhere in this file (MC1: "immutable after creation in
 * MVP" — the only recovery is close + recreate), so this is also the ONLY place
 * an invalid currency could ever enter the ledger.
 */
export class UnsupportedCurrencyError extends Error {
  constructor(currency: string) {
    super(`'${currency}' is not a supported currency`);
    this.name = 'UnsupportedCurrencyError';
  }
}

/**
 * Thrown for a start (opening) date the account can't take (C6, N-10, N-11): one after today, or,
 * on an edit, one moved past the account's first row. The message is the field's.
 */
export class OpeningDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpeningDateError';
  }
}

/** C6: an account starts today or earlier (a future start counted in the headline before the line). */
function refuseFutureStart(date: string | null): void {
  if (date !== null && date > formatDate(today(appClock()))) {
    throw new OpeningDateError("The start date can't be after today");
  }
}

/**
 * Thrown when a close would leave rows dated after it: the account would be closed but
 * hold money as of today, so the headline and the net worth line would disagree.
 */
export class UpcomingRowsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpcomingRowsError';
  }
}

/**
 * Why an account can't close on `onDate` yet: the live rows dated after it, as the message the
 * close dialog shows ("This account has 1 upcoming row (5 Dec 2026). Delete or move it first."),
 * or null when there are none.
 */
/**
 * Why an account can't close today, or null (F1): a row dated after the close, or an
 * account that belongs to it still holding money (S5 RD16: an EPF's EPS; close the EPS first, on
 * its tab, so its money is moved or written off by its own close).
 */
export function closeRefusal(database: Db, accountId: string, onDate: string): string | null {
  const upcoming = upcomingRowsMessage(database, accountId, onDate);
  if (upcoming) return upcoming;
  for (const id of childAccountIds(database, accountId)) {
    const child = database.db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (child?.status === 'open' && accountBalance(database.sqlite, id, onDate) !== 0) {
      return `Its ${moduleProfile(child.type)?.label.split(' ')[0] ?? 'linked account'} still holds money. Close that first, on its tab.`;
    }
  }
  return null;
}

export function upcomingRowsMessage(database: Db, accountId: string, onDate: string): string | null {
  const r = database.sqlite
    .prepare(
      `SELECT COUNT(*) AS n, MIN(date) AS first FROM transactions
        WHERE account_id = ? AND deleted_at IS NULL AND date > ?`,
    )
    .get(accountId, onDate) as { n: number; first: string | null };
  if (r.n === 0 || r.first === null) return null;
  return r.n === 1
    ? `This account has 1 upcoming row (${formatDisplayDate(r.first)}). Delete or move it first.`
    : `This account has ${r.n} upcoming rows (the first on ${formatDisplayDate(r.first)}). Delete or move them first.`;
}

/**
 * Whether the owner already has a live OPEN account of this `type` whose name
 * matches (normalized). Scoped to `ownerId` for privacy (see file header) and to
 * `status = 'open'` because a CLOSED account's name may be reused (F1). An
 * optional `excludeId` skips the account itself (used by reopen).
 */
export function openNameTaken(
  db: Db['db'],
  ownerId: string,
  type: string,
  name: string,
  excludeId?: string,
  /** Only these accounts count, the ones the person acting can see. A holder of a
   *  shared account must not learn, from a refused rename, the name of the owner's private one. */
  among?: ReadonlySet<string>,
): boolean {
  const target = normalizeName(name);
  const rows = db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.ownerId, ownerId),
        eq(schema.accounts.type, type),
        eq(schema.accounts.status, 'open'),
        isNull(schema.accounts.deletedAt),
      ),
    )
    .all();
  return rows.some((r) => r.id !== excludeId && (among === undefined || among.has(r.id)) && normalizeName(r.name) === target);
}

/**
 * Create an OPEN account inside a module. Stamps `owner_id` (private by default),
 * stores the opening balance as a COLUMN (`opening_paise` + `opening_date`) — no
 * opening transaction row. Zero opening balance → no opening date (F1 RD5).
 * Throws on an unknown module, an empty name, a start date after today
 * (`OpeningDateError`, C6), or a name that collides with one of the owner's own
 * open accounts of the same module.
 */
export async function createAccount(
  { db }: Db,
  input: CreateAccountInput,
): Promise<AccountSummary> {
  if (!hasModule(input.type)) {
    throw new Error(`createAccount: no module registered for type '${input.type}'`);
  }
  if (!isSupportedCurrency(input.currency)) {
    throw new UnsupportedCurrencyError(input.currency);
  }
  const name = input.name.trim();
  if (name === '') throw new Error('createAccount: name is required');

  // Opening balance and its as-of date move together: a non-zero opening needs a
  // date; a zero opening has neither (no "Starting balance" row to date).
  const openingPaise = input.openingPaise;
  const openingDate = openingPaise === 0 ? null : input.openingDate;
  if (openingPaise !== 0 && !openingDate) {
    throw new Error('createAccount: opening date is required for a non-zero opening balance');
  }
  if (openingDate !== null && !isRealDate(openingDate)) {
    throw new Error(`createAccount: opening date must be a real day as 'YYYY-MM-DD', got '${openingDate}'`);
  }
  refuseFutureStart(openingDate);

  if (openNameTaken(db, input.ownerId, input.type, name)) {
    throw new AccountNameConflictError('An open account with that name already exists');
  }

  const infoJson = input.infoJson ?? null;
  const id = randomUUID();
  db.insert(schema.accounts)
    .values({
      id,
      ownerId: input.ownerId,
      name,
      type: input.type,
      currency: input.currency,
      status: 'open',
      openingPaise,
      openingDate,
      infoJson,
      parentAccountId: input.parentAccountId ?? null,
    })
    .run();

  return {
    id,
    ownerId: input.ownerId,
    name,
    type: input.type,
    currency: input.currency,
    status: 'open',
    openingPaise,
    openingDate,
    infoJson,
    balancePaise: openingPaise, // no transactions yet → balance == opening
  };
}

export interface CreateHoldingAccountInput {
  readonly ownerId: string;
  readonly type: string;
  readonly name: string;
  readonly currency: string;
  /** Amount invested = the cost basis / opening (S2 RD1). ≥ 0 (asset holdings). */
  readonly investedPaise: number;
  /** As-of date of the invested amount; required when investedPaise ≠ 0. */
  readonly investedDate: string | null;
  /** Current value now. When given and ≠ invested, the gap is posted as an
   *  initial valuation mark (dated today) so return is correct from day one. */
  readonly currentValuePaise: number | null;
  readonly infoJson?: string | null;
}

/**
 * Onboard an ASSET holding (Mutual Funds, Stocks, FD, RD, Property, Gold,
 * Other-asset) capturing BOTH invested + current value (S2 RD1): opening =
 * invested (the cost basis), then an initial valuation mark (S3) lifts the value
 * to `currentValue`, so the holding shows a correct return from creation. If
 * current value is omitted or equals invested, no mark is posted (return 0%).
 *
 * Not atomic across the two writes by design: a failed mark leaves a valid
 * holding at its invested value (0% return), re-markable via S3 — a benign
 * partial, never a corrupt ledger. (Liability holdings — Loans, Other-liability —
 * onboard their OUTSTANDING through `createAccount` with a negative opening, no
 * invested/value pair, so they do not use this path.)
 */
export async function createHoldingAccount(
  database: Db,
  input: CreateHoldingAccountInput,
): Promise<AccountSummary> {
  const { sqlite } = database;
  const created = await createAccount(database, {
    ownerId: input.ownerId,
    type: input.type,
    name: input.name,
    currency: input.currency,
    openingPaise: input.investedPaise,
    openingDate: input.investedDate,
    infoJson: input.infoJson ?? null,
  });

  if (input.currentValuePaise !== null && input.currentValuePaise !== input.investedPaise) {
    await postValuationMark(
      database,
      { userId: input.ownerId },
      {
        accountId: created.id,
        targetPaise: input.currentValuePaise,
        date: formatDate(today(appClock())),
      },
    );
  }

  // Re-read the derived balance (the mark moved it above the opening).
  return { ...created, balancePaise: accountBalance(sqlite, created.id) };
}

/**
 * S5 RD16: make an account's child (an EPF's EPS) with it: the child profile's type, named its
 * prefix + the parent's name, the parent's owner and currency, its own opening (what was paid in so
 * far, dated with the parent's opening or today). Nothing copies the parent's holders: the one
 * caller makes the EPS in the same request as its EPF, before anyone can be added, and a later
 * share or unshare of either walks the whole family (`sharing.ts`, `accountFamilyIds`).
 */
export async function createChildAccount(
  database: Db,
  parentId: string,
  openingPaise: number,
  openingDate: string | null,
): Promise<AccountSummary> {
  const parent = database.db.select().from(schema.accounts).where(eq(schema.accounts.id, parentId)).get();
  const child = parent ? moduleProfile(parent.type)?.child : undefined;
  if (!parent || !child) throw new Error(`createChildAccount: account '${parentId}' has no child type`);
  return createAccount(database, {
    ownerId: parent.ownerId,
    type: child.type,
    name: `${child.namePrefix}${parent.name}`,
    currency: parent.currency,
    openingPaise,
    openingDate: openingPaise === 0 ? null : (openingDate ?? formatDate(today(appClock()))),
    parentAccountId: parent.id,
  });
}

/** The open or closed child accounts of an account (an EPF's EPS), ids only. */
export function childAccountIds(database: Db, parentId: string): string[] {
  return database.db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.parentAccountId, parentId), isNull(schema.accounts.deletedAt)))
    .all()
    .map((r) => r.id);
}

/**
 * Correct an account's opening balance (amount + as-of date). This is F1's
 * "fix a wrong opening balance" recovery path — and, per the M5 build
 * reconciliation, it is an ACCOUNT-FIELD edit (the opening is a dated COLUMN),
 * NOT a C4 transaction-row edit. Same coupling rule as create: a non-zero
 * opening requires a valid 'YYYY-MM-DD' date; a zero opening carries none.
 * Balance stays derived (`opening_paise + Σtx`), so this shifts every running
 * balance for the account by construction, no row rewrite needed. A closed account's
 * opening can't change (`ClosedAccountError`): reopen first. A changed start date can't be
 * after today or after the account's first row (`OpeningDateError`, C6 and N-10).
 */
export async function setOpeningBalance(
  database: Db,
  accountId: string,
  openingPaise: number,
  openingDate: string | null,
): Promise<AccountSummary> {
  const { db, sqlite } = database;
  const account = db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.deletedAt)))
    .get();
  if (!account) throw new Error(`setOpeningBalance: no account with id ${accountId}`);
  // Nothing on a closed account changes; a new opening would give it a balance again.
  if (account.status !== 'open') {
    throw new ClosedAccountError('This account is closed. Reopen it to change its opening balance.');
  }

  const date = openingPaise === 0 ? null : openingDate;
  if (openingPaise !== 0 && !date) {
    throw new Error('setOpeningBalance: opening date is required for a non-zero opening balance');
  }
  if (date !== null && !isRealDate(date)) {
    throw new Error(`setOpeningBalance: opening date must be a real day as 'YYYY-MM-DD', got '${date}'`);
  }
  if (date !== account.openingDate) {
    refuseFutureStart(date);
    // N-10: the net worth line counts an account from its start date, so a start moved past the
    // first row would drop that row from every earlier point. (A row typed before an unchanged
    // start stays allowed, C4 RD5; only the move is refused.)
    const first = sqlite
      .prepare('SELECT MIN(date) AS d FROM transactions WHERE account_id = ? AND deleted_at IS NULL')
      .get(accountId) as { d: string | null };
    if (date !== null && first.d !== null && date > first.d) {
      throw new OpeningDateError(`The start date can't be after the account's first row (${formatDisplayDate(first.d)})`);
    }
  }

  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(schema.accounts)
      .set({ openingPaise, openingDate: date, updatedAt: nowIso })
      .where(eq(schema.accounts.id, accountId))
      .run();
    // S3 RD1: a value update keeps the value the person typed; the new opening moves
    // its gap, not the value ("worth ₹1.5L on 31 Oct" stays ₹1.5L).
    reconcileMarks(tx as unknown as Db['db'], accountId, nowIso);
  });

  const updated = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get()!;
  return toSummary(sqlite, updated);
}

export interface CloseAccountOptions {
  /** Date 'YYYY-MM-DD' to stamp on the closing adjustment. Defaults to today. */
  readonly closeDate?: string;
  /** Who is closing — stamped as `entered_by` on the adjustment (nullable). */
  readonly actingUserId?: string;
}

/**
 * Force-close an account: zero its derived balance with ONE closing adjustment
 * (if non-zero) and flip status to 'closed', ATOMICALLY. A zero-balance account
 * closes with no adjustment. Idempotent-ish: closing an already-closed account
 * is a no-op that still returns its summary. Throws if the account is missing,
 * and `UpcomingRowsError` while it has rows dated after the close.
 *
 * The adjustment is a plain `ordinary` transaction stamped with the seeded
 * "Balance adjustment" category (Neutral kind — audit decision 2026-07-12):
 * categorized → it never lands in the C5 inbox; Neutral → excluded from R2/R3
 * spending/income. If the user deleted that seeded category, the entry degrades
 * to uncategorized (same fallback posture as Actual's closeAccount).
 */
export async function closeAccount(
  database: Db,
  accountId: string,
  opts: CloseAccountOptions = {},
): Promise<AccountSummary> {
  const { db, sqlite } = database;
  const account = db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.deletedAt)))
    .get();
  if (!account) throw new Error(`closeAccount: no account with id ${accountId}`);
  if (account.status === 'closed') return toSummary(sqlite, account);

  const closeDate = opts.closeDate ?? formatDate(today(appClock()));
  const nowIso = new Date().toISOString();

  db.transaction((tx) => {
    // A row dated after the close would stay outside the zeroing (the account closed but
    // holding money as of today), so the close waits until it is deleted or moved.
    const refusal = closeRefusal(database, accountId, closeDate);
    if (refusal) throw new UpcomingRowsError(refusal);
    // Read the derived balance INSIDE the transaction (same connection) so no
    // concurrent write can slip between the read and the zeroing adjustment.
    const balance = accountBalance(sqlite, accountId);
    if (balance !== 0) {
      // The ONE sequence convention shared by all writers (transactions.ts):
      // per-(account, date) MAX + 1, tombstone-inclusive so a later C4 restore
      // can never collide with a sequence issued while a row was soft-deleted.
      const sequence = nextSequenceOn(tx as unknown as Db['db'], accountId, closeDate);

      // The system balancing category, if it still exists (live) — else null.
      const adjustmentCategory = tx
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
          and(
            eq(schema.categories.id, BALANCE_ADJUSTMENT_CATEGORY_ID),
            isNull(schema.categories.deletedAt),
          ),
        )
        .get();

      tx.insert(schema.transactions)
        .values({
          id: randomUUID(),
          accountId,
          date: closeDate,
          sequence,
          amountPaise: -balance, // exact zeroing: balance + (-balance) === 0
          categoryId: adjustmentCategory?.id ?? null,
          enteredBy: opts.actingUserId ?? null,
          kind: 'ordinary',
        })
        .run();

      // Defensive (S3 RD1): the zeroing adjustment shifts the running balance;
      // if the holding carries any future-dated mark, re-derive it. No-op for a
      // spending account or a holding with no marks after the close date.
      reconcileMarks(tx as unknown as Db['db'], accountId, nowIso);
    }

    tx.update(schema.accounts)
      .set({ status: 'closed', updatedAt: nowIso })
      .where(eq(schema.accounts.id, accountId))
      .run();
    // S5 RD16: the accounts that belong to it (an EPF's EPS, at zero by `closeRefusal`) close with it.
    for (const id of childAccountIds(database, accountId)) {
      tx.update(schema.accounts).set({ status: 'closed', updatedAt: nowIso }).where(eq(schema.accounts.id, id)).run();
    }
  });

  const closed = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get()!;
  return toSummary(sqlite, closed);
}

/**
 * Rename an account (UX-REVIEW P7; F1 assumes a rename: "prompt to rename" on a reopen
 * collision). The same rule as create and reopen: no two OPEN accounts of one owner and module
 * share a name, among the accounts `actorId` can see (a holder renaming a shared account learns
 * nothing of the owner's private ones). Throws `AccountNameConflictError` on a clash; nothing
 * changes then.
 */
export async function renameAccount(database: Db, accountId: string, newName: string, actorId: string): Promise<AccountSummary> {
  const { db, sqlite } = database;
  const name = newName.trim();
  if (name === '') throw new Error('renameAccount: name is required');
  const account = db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.deletedAt)))
    .get();
  if (!account) throw new Error(`renameAccount: no account with id ${accountId}`);
  if (account.name === name) return toSummary(sqlite, account);
  if (account.status === 'open' && openNameTaken(db, account.ownerId, account.type, name, account.id, new Set(await accountsVisibleTo(db, actorId)))) {
    throw new AccountNameConflictError('An open account with that name already exists');
  }
  db.update(schema.accounts)
    .set({ name, updatedAt: new Date().toISOString() })
    .where(eq(schema.accounts.id, accountId))
    .run();
  // S5 RD16: an account's children carry its name ("EPS of " + the EPF's).
  const child = moduleProfile(account.type)?.child;
  if (child) {
    for (const id of childAccountIds(database, accountId)) {
      db.update(schema.accounts).set({ name: `${child.namePrefix}${name}`, updatedAt: new Date().toISOString() }).where(eq(schema.accounts.id, id)).run();
    }
  }
  const renamed = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get()!;
  return toSummary(sqlite, renamed);
}

/**
 * S5 RD8: replace an account's informational fields (Edit account; `null` clears them all).
 * Display-only (S5 RD3): no figure reads them, so no balance or history changes.
 */
export async function setAccountInfo(database: Db, accountId: string, infoJson: string | null): Promise<void> {
  const { db } = database;
  const result = db
    .update(schema.accounts)
    .set({ infoJson, updatedAt: new Date().toISOString() })
    .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.deletedAt)))
    .run();
  if (result.changes === 0) throw new Error(`setAccountInfo: no account with id ${accountId}`);
}

/**
 * Reopen a closed account, history intact. Re-checks the name against the
 * owner's current OPEN accounts of the same module (an account may have been
 * created with this name while it was closed — F1 edge). On collision, throws
 * `AccountNameConflictError` so the caller can prompt a rename; nothing changes. Only the accounts
 * `actorId` can see count (as `renameAccount`).
 */
export async function reopenAccount(database: Db, accountId: string, actorId: string): Promise<AccountSummary> {
  const { db, sqlite } = database;
  const account = db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.deletedAt)))
    .get();
  if (!account) throw new Error(`reopenAccount: no account with id ${accountId}`);
  if (account.status === 'open') return toSummary(sqlite, account);

  if (openNameTaken(db, account.ownerId, account.type, account.name, account.id, new Set(await accountsVisibleTo(db, actorId)))) {
    throw new AccountNameConflictError(
      'Another open account uses this name. Rename it before reopening.',
    );
  }

  db.update(schema.accounts)
    .set({ status: 'open', updatedAt: new Date().toISOString() })
    .where(eq(schema.accounts.id, accountId))
    .run();
  // S5 RD16: reopening an EPF reopens its EPS (they closed together).
  for (const id of childAccountIds(database, accountId)) {
    db.update(schema.accounts).set({ status: 'open', updatedAt: new Date().toISOString() }).where(eq(schema.accounts.id, id)).run();
  }

  const reopened = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get()!;
  return toSummary(sqlite, reopened);
}

/**
 * The viewer's accounts, with derived balances — funneled through the P0
 * `accountsVisibleTo` predicate (owned ∪ member-of), never a broader read.
 * Open-only by default; `includeClosed` adds the "Closed accounts" set.
 */
export async function listAccounts(
  database: Db,
  userId: string,
  opts: { includeClosed?: boolean } = {},
): Promise<AccountSummary[]> {
  const { db, sqlite } = database;
  const visibleIds = await accountsVisibleTo(db, userId);
  if (visibleIds.length === 0) return [];

  // Filter in SQL, not in JS: only the visible rows ever leave the database
  // (the letter of "never a broader read", not just its effect).
  const rows = db
    .select()
    .from(schema.accounts)
    .where(
      and(
        isNull(schema.accounts.deletedAt),
        inArray(schema.accounts.id, visibleIds),
        opts.includeClosed ? undefined : eq(schema.accounts.status, 'open'),
      ),
    )
    .all();

  // H2 RD9: an account the viewer holds from a date carries no opening (it is from before).
  const stretches = viewerStretches(db, userId, rows.filter((a) => a.ownerId !== userId).map((a) => a.id));
  // Every balance in one grouped sum: it was one query per account, on every page (Quick
  // add's account list rides on the layout).
  // (At the shared "today" cuts over every visible account, so the request sums once.)
  const sums = ledgerCuts(sqlite, visibleIds, todayCuts(today(appClock()))).sums;
  return rows.map((a) => {
    const all = sums.get(a.id);
    const s = summaryOf(a, a.openingPaise + (all ? all[0]! + all[1]! + all[2]! : 0));
    const first = stretches.get(a.id)?.[0]?.from;
    return first !== undefined && first !== SINCE_START ? { ...s, openingPaise: 0, openingDate: null } : s;
  });
}

/** An account the viewer held once and no longer does (C5 C), for All accounts' closed list. */
export interface HeldBeforeSummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly currency: string;
  /** The last day they held it. */
  readonly heldUntil: string;
  /** Its balance that day (nothing later is theirs to see). */
  readonly balancePaise: number;
}

/** The accounts the viewer held once: read-only, for the dates they held them (C5 C, H2 RD9). */
export async function listAccountsHeldBefore(database: Db, userId: string): Promise<HeldBeforeSummary[]> {
  const { db, sqlite } = database;
  const ids = await accountsHeldBefore(db, userId);
  if (ids.length === 0) return [];
  const stretches = viewerStretches(db, userId, ids);
  const rows = db.select().from(schema.accounts).where(inArray(schema.accounts.id, ids)).all();
  const until = new Map<string, string>();
  for (const a of rows) {
    const last = stretches.get(a.id)?.at(-1)?.to;
    if (last) until.set(a.id, formatDate(parseDate(last).subtract({ days: 1 })));
  }
  // The balances on the days they were left, one grouped sum per distinct day.
  const byDay = new Map<string, ReadonlyMap<string, readonly number[]>>();
  for (const day of new Set(until.values())) {
    byDay.set(day, ledgerCuts(sqlite, [...until].filter(([, d]) => d === day).map(([id]) => id), [day]).sums);
  }
  return rows.flatMap((a) => {
    const heldUntil = until.get(a.id);
    if (heldUntil === undefined) return [];
    const balancePaise = a.openingPaise + (byDay.get(heldUntil)?.get(a.id)?.[0] ?? 0);
    return [{ id: a.id, name: a.name, type: a.type, currency: a.currency, heldUntil, balancePaise }];
  });
}

type AccountRow = typeof schema.accounts.$inferSelect;

/** Row → summary, attaching the derived balance from the crown-jewel window fn. */
function toSummary(sqlite: Db['sqlite'], a: AccountRow): AccountSummary {
  return summaryOf(a, accountBalance(sqlite, a.id));
}

/** Row → summary with its derived balance (opening + every live row, future-dated included). */
function summaryOf(a: AccountRow, balancePaise: number): AccountSummary {
  return {
    id: a.id,
    ownerId: a.ownerId,
    type: a.type,
    name: a.name,
    currency: a.currency,
    status: a.status,
    openingPaise: a.openingPaise,
    openingDate: a.openingDate,
    infoJson: a.infoJson,
    balancePaise,
  };
}
