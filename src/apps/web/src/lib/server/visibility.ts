/**
 * visibility.ts — `accountsVisibleTo` — THE P0 PRIVACY SERVICE.
 * ============================================================================
 * This is M4's crown jewel, the analogue of M3's running-balance window fn.
 * Privacy is a P0 invariant (docs/product/architecture.md §12; security.md): a
 * non-holder must NOT be able to see an account, its balance, its transactions,
 * or even learn that it EXISTS — INCLUDING via the admin role. Admin manages
 * membership; admin is NOT a data super-user.
 *
 * The whole model funnels through ONE predicate defined here — `visibleWhere` —
 * so there is exactly one visibility rule and screens cannot drift
 * (contracts.md §C, shared-service discipline). Every viewer-scoped read/write
 * path MUST resolve access through this service, SERVER-SIDE — never UI-only
 * (an endpoint that trusts the client to hide an account is the P0 failure).
 *
 * The visible set for a user U is:
 *     accounts they OWN            (accounts.owner_id = U)
 *   ∪ accounts they are a MEMBER of (a row in account_members)
 * over live (non-tombstoned) accounts. There is deliberately NO role clause —
 * that omission is the privacy guarantee, and the adversarial test asserts that
 * adding an all-accounts / admin bypass turns the privacy e2e RED.
 *
 * R8 async-service convention: returns Promises though better-sqlite3 is sync.
 * ============================================================================
 */
import { and, asc, eq, exists, inArray, isNull, or, sql } from 'drizzle-orm';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { today, formatDate } from '@miserly/core';
import { appClock } from './clock';

type AppDb = Db['db'];

/**
 * THE single visibility predicate: `owned ∪ member-of`, live accounts only.
 * Used by BOTH `accountsVisibleTo` (the set) and `isAccountVisibleTo` (one
 * account) so the rule exists in exactly one place. The membership arm is a
 * correlated EXISTS over `account_members`; there is intentionally no `role`
 * term — admin gets no special visibility.
 */
function visibleWhere(db: AppDb, userId: string) {
  const membership = db
    .select({ one: sql`1` })
    .from(schema.accountMembers)
    .where(
      and(
        eq(schema.accountMembers.accountId, schema.accounts.id),
        eq(schema.accountMembers.userId, userId),
        isNull(schema.accountMembers.deletedAt),
      ),
    );
  return and(
    isNull(schema.accounts.deletedAt),
    or(eq(schema.accounts.ownerId, userId), exists(membership)),
  );
}

/**
 * The set of account ids the viewer may see (`owned ∪ member-of`). This is the
 * input to every viewer-scoped aggregate (net worth, allocation, activity — M7)
 * and to every list. An empty array means "this user sees nothing", never "all".
 */
export async function accountsVisibleTo(db: AppDb, userId: string): Promise<string[]> {
  const rows = db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(visibleWhere(db, userId))
    .all();
  return rows.map((r) => r.id);
}

/**
 * Whether a SINGLE account is visible to the viewer — the check a per-account
 * load/endpoint MUST make before revealing anything. A `false` result must be
 * surfaced identically to a non-existent id (same 404/redirect), so existence is
 * never leaked. Implemented via the SAME `visibleWhere` predicate as the set.
 */
export async function isAccountVisibleTo(
  db: AppDb,
  userId: string,
  accountId: string,
): Promise<boolean> {
  const row = db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), visibleWhere(db, userId)))
    .get();
  return row !== undefined;
}

// ── The dates a holder held an account (C5 C; H2 RD9, architecture §12) ─────

/**
 * Everything above is the CURRENT holder test, and every write, picker and today's figure stays
 * on it. A member who has left keeps reading the dates they held (C5 C: "read-only after leaving,
 * nothing later"), and a member sees only the dates since they joined ("Balance when you joined",
 * nothing earlier). These helpers are the one place that rule lives:
 *
 *  - `accountsHeldBefore` / `accountsReadableBy` / `isAccountReadableBy`: the accounts a viewer
 *    may READ (current ∪ held once). Only the reads that show a holder's past use them: the
 *    register, Reports and the net worth line. Nothing writes through them.
 *  - `viewerStretches` / `heldRowSql`: which dates of an account the viewer held (the owner, every
 *    date). Every row a viewer reads or writes on an account they don't own must fall inside them.
 *  - `canWriteOn`: a current holder, on a date they hold.
 */

/** The live accounts `userId` held once and no longer does (they left; the owner never does). */
export async function accountsHeldBefore(db: AppDb, userId: string): Promise<string[]> {
  const current = new Set(await accountsVisibleTo(db, userId));
  const rows = db
    .selectDistinct({ id: schema.accountHolderPeriods.accountId })
    .from(schema.accountHolderPeriods)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.accountHolderPeriods.accountId))
    .where(and(eq(schema.accountHolderPeriods.userId, userId), isNull(schema.accounts.deletedAt)))
    .all();
  return rows.map((r) => r.id).filter((id) => !current.has(id));
}

/** The accounts a viewer may read: those they hold now and those they held once (read-only). */
export async function accountsReadableBy(db: AppDb, userId: string): Promise<string[]> {
  return [...(await accountsVisibleTo(db, userId)), ...(await accountsHeldBefore(db, userId))];
}

/** Whether the viewer may read one account (a holder now, or once). Same 404 otherwise. */
export async function isAccountReadableBy(db: AppDb, userId: string, accountId: string): Promise<boolean> {
  if (await isAccountVisibleTo(db, userId, accountId)) return true;
  return (await accountsHeldBefore(db, userId)).includes(accountId);
}

/**
 * The viewer's stretches on each of `accountIds`: the owner holds every date (one stretch from the
 * start), a member their own (`memberStretches`); an account they never held has none.
 */
export function viewerStretches(db: AppDb, userId: string, accountIds: readonly string[]): Map<string, Stretch[]> {
  const out = new Map<string, Stretch[]>();
  if (accountIds.length === 0) return out;
  const owners = db
    .select({ id: schema.accounts.id, ownerId: schema.accounts.ownerId })
    .from(schema.accounts)
    .where(inArray(schema.accounts.id, [...accountIds]))
    .all();
  const members = memberStretches(db, accountIds);
  for (const a of owners) {
    out.set(a.id, a.ownerId === userId ? [{ from: SINCE_START, to: null }] : (members.get(a.id)?.get(userId) ?? []));
  }
  return out;
}

/** True when the viewer holds `accountId` on `date` (owner: always). */
export function holdsOnDate(db: AppDb, userId: string, accountId: string, date: string): boolean {
  return inStretches(viewerStretches(db, userId, [accountId]).get(accountId) ?? [], date);
}

/** True when the viewer holds `accountId` now and `date` is one of their dates: they may write a
 *  row dated `date` there (C5 C: nothing before they joined, nothing after they left). */
export async function canWriteOn(db: AppDb, userId: string, accountId: string, date: string): Promise<boolean> {
  return (await isAccountVisibleTo(db, userId, accountId)) && holdsOnDate(db, userId, accountId, date);
}

/**
 * SQL: the row `alias` (a `transactions` row) falls inside the dates the viewer (the named
 * parameter `param`, e.g. '@viewer') held its account: they own it, or one of their stretches
 * covers its date, or they hold a grant from before 0013 with no open stretch (held since the
 * start). The same rule as `viewerStretches`, for queries that list rows.
 */
export function heldRowSql(alias: string, param: string): string {
  return `(EXISTS (SELECT 1 FROM accounts hw WHERE hw.id = ${alias}.account_id AND hw.owner_id = ${param})
    OR EXISTS (SELECT 1 FROM account_holder_periods hp WHERE hp.account_id = ${alias}.account_id AND hp.user_id = ${param}
      AND hp.from_date <= ${alias}.date AND (hp.to_date IS NULL OR ${alias}.date < hp.to_date))
    OR EXISTS (SELECT 1 FROM account_members hm WHERE hm.account_id = ${alias}.account_id AND hm.user_id = ${param} AND hm.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM account_holder_periods hq WHERE hq.account_id = hm.account_id AND hq.user_id = hm.user_id AND hq.to_date IS NULL)))`;
}

/** The viewer's current accounts split by how much of them they hold (C5 C). */
export interface HeldScope {
  /** Every current account. */
  readonly all: string[];
  /** Held on every date: owned, or a grant from before 0013. */
  readonly full: string[];
  /** Held from a date on (a member since they were added): their stretches. */
  readonly partial: Map<string, Stretch[]>;
}

/** The viewer's current accounts, split into those held on every date and those held from a date. */
export async function heldScope(db: AppDb, userId: string): Promise<HeldScope> {
  const all = await accountsVisibleTo(db, userId);
  const stretches = viewerStretches(db, userId, all);
  const full: string[] = [];
  const partial = new Map<string, Stretch[]>();
  for (const id of all) {
    const s = stretches.get(id) ?? [];
    if (s.some((x) => x.from === SINCE_START && x.to === null)) full.push(id);
    else partial.set(id, s);
  }
  return { all, full, partial };
}

/**
 * The rows of a scope's accounts inside the dates held: `heldRowCondition`, checked only where it
 * can fail. A `full` account (owned, or held since the start) needs no check per row (three
 * EXISTS per row of the history, on every page, for the Inbox count and Quick add's payees).
 */
export function heldRowsIn(scope: HeldScope, userId: string) {
  const t = schema.transactions;
  const partial = [...scope.partial.keys()];
  const some = partial.length > 0 ? and(inArray(t.accountId, partial), heldRowCondition(userId)) : undefined;
  const full = scope.full.length > 0 ? inArray(t.accountId, scope.full) : undefined;
  if (full && some) return or(full, some)!;
  return full ?? some ?? sql`0`;
}

/** The part of a scope on the given accounts. */
export function scopeOn(scope: HeldScope, ids: readonly string[]): HeldScope {
  const keep = new Set(ids);
  return {
    all: scope.all.filter((id) => keep.has(id)),
    full: scope.full.filter((id) => keep.has(id)),
    partial: new Map([...scope.partial].filter(([id]) => keep.has(id))),
  };
}

/** True when a row on `accountId` dated `date` is inside the scope (a held date of a current account). */
export function inScope(scope: HeldScope, accountId: string, date: string): boolean {
  if (scope.full.includes(accountId)) return true;
  const s = scope.partial.get(accountId);
  return s !== undefined && inStretches(s, date);
}

/**
 * Drizzle's form of `heldRowSql` for the `transactions` table: the row falls inside the dates
 * `userId` held its account (the user id is bound as a parameter).
 */
export function heldRowCondition(userId: string) {
  const t = schema.transactions;
  return sql`(EXISTS (SELECT 1 FROM accounts hw WHERE hw.id = ${t.accountId} AND hw.owner_id = ${userId})
    OR EXISTS (SELECT 1 FROM account_holder_periods hp WHERE hp.account_id = ${t.accountId} AND hp.user_id = ${userId}
      AND hp.from_date <= ${t.date} AND (hp.to_date IS NULL OR ${t.date} < hp.to_date))
    OR EXISTS (SELECT 1 FROM account_members hm WHERE hm.account_id = ${t.accountId} AND hm.user_id = ${userId} AND hm.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM account_holder_periods hq WHERE hq.account_id = hm.account_id AND hq.user_id = hm.user_id AND hq.to_date IS NULL)))`;
}

// ── Joint accounts: the viewer's share (H2 RD8, RD9, architecture §12) ─

/** The start of a holder's stretch for a grant from before migration 0013: held since the start. */
export const SINCE_START = '0001-01-01';

/** One stretch a member held an account: from `from` up to but not including `to` (null = still). */
export interface Stretch {
  readonly from: string;
  readonly to: string | null;
}

/** Whether `date` falls inside one of `stretches`. */
export function inStretches(stretches: readonly Stretch[], date: string): boolean {
  return stretches.some((s) => s.from <= date && (s.to === null || date < s.to));
}

/**
 * Each member's stretches on `accountIds` (the owner has none: they hold the account for its whole
 * life). From `account_holder_periods` (migration 0013); a live `account_members` grant with no open
 * stretch is one from before 0013 and counts as held since the start (what that member saw until
 * then). Includes members who have left (closed stretches only), and members removed from the
 * Circle: their dates stay theirs, so nobody else's past changes.
 */
export function memberStretches(db: AppDb, accountIds: readonly string[]): Map<string, Map<string, Stretch[]>> {
  const out = new Map<string, Map<string, Stretch[]>>();
  if (accountIds.length === 0) return out;
  const ids = [...accountIds];
  const add = (accountId: string, userId: string, s: Stretch) => {
    let byUser = out.get(accountId);
    if (!byUser) out.set(accountId, (byUser = new Map()));
    const list = byUser.get(userId);
    if (list) list.push(s);
    else byUser.set(userId, [s]);
  };
  const periods = db
    .select()
    .from(schema.accountHolderPeriods)
    .where(inArray(schema.accountHolderPeriods.accountId, ids))
    .orderBy(asc(schema.accountHolderPeriods.fromDate))
    .all();
  for (const p of periods) add(p.accountId, p.userId, { from: p.fromDate, to: p.toDate });
  const live = db
    .select({ accountId: schema.accountMembers.accountId, userId: schema.accountMembers.userId })
    .from(schema.accountMembers)
    .where(and(inArray(schema.accountMembers.accountId, ids), isNull(schema.accountMembers.deletedAt)))
    .all();
  for (const m of live) {
    const own = out.get(m.accountId)?.get(m.userId) ?? [];
    if (!own.some((s) => s.to === null)) add(m.accountId, m.userId, { from: SINCE_START, to: null });
  }
  return out;
}

/**
 * The viewer's share of each account they hold, the one place weights come from. Net worth,
 * allocation, history and Reports multiply each account's contract output by it before summing;
 * the aggregation contract and the modules never see it. Records (registers, Recent activity, the
 * sidebar's account rows) keep full amounts.
 *
 *  - A sole-held account (no member, ever) is the viewer's in full.
 *  - A shared account's holders on a date are its owner and the members who held it that day
 *    (`memberStretches`; H2 RD9, C5 C: a holder counts for the dates they held it). A viewer who
 *    didn't hold it that day has none of it.
 *  - Shares are dated (`account_shares`, migration 0010): each change applies from its
 *    `effective_from` until the next; before the first change, or with none, the holders that day
 *    are equal (1/n). So sharing splits from the day it's shared and unsharing ends the split that
 *    day: nobody's past changes.
 *  - Under a stated split a holder with no row (added later) has 0 %, and the share of someone not
 *    holding it that day returns to the owner: the owner's part is always the account's amount less
 *    every other holder's part that day. Each other holder's part is rounded half-even to the
 *    paisa, so the holders' parts add to the account's amount exactly.
 */
export interface ViewerShares {
  /** True when the account has more than one holder on `date` (today by default). */
  isShared(accountId: string, date?: string): boolean;
  /** The viewer's part of `paise` in the share period that starts on `period` (the latest change
   *  on or before the date, as `SHARE_PERIOD_SQL` finds it; null = before any change). */
  partIn(accountId: string, paise: number, period: string | null): number;
  /** The viewer's part of `paise` on `date` (ISO 'YYYY-MM-DD'). */
  partOn(accountId: string, paise: number, date: string): number;
  /** The viewer's share on `date` in basis points (10,000 = 100 %), for "your share" notes. */
  shareBpOn(accountId: string, date: string): number;
  /** The dates the viewer's share of the account may change (a split's From, a holder joining or
   *  leaving), ascending; empty for a sole-held account. */
  changeDates(accountId: string): string[];
}

/**
 * A report row's share period, for a query over `transactions t`: the latest date on or before the
 * row's on which anything about the account's split changed (a stated split's From, a member
 * joining or leaving), or null before any. Rows in one period share one split, so the reports sum
 * them first and weight the sum once.
 */
export const SHARE_PERIOD_SQL = `NULLIF(MAX(
    COALESCE((SELECT MAX(s.effective_from) FROM account_shares s WHERE s.account_id = t.account_id AND s.effective_from <= t.date), ''),
    COALESCE((SELECT MAX(hp.from_date) FROM account_holder_periods hp WHERE hp.account_id = t.account_id AND hp.from_date <= t.date), ''),
    COALESCE((SELECT MAX(hp.to_date) FROM account_holder_periods hp WHERE hp.account_id = t.account_id AND hp.to_date <= t.date), '')
  ), '')`;

/** `paise × num / den`, rounded half-even to the paisa (BigInt: paise × 10,000 can pass 2^53). */
export function halfEvenPart(paise: number, num: number, den: number): number {
  const x = BigInt(paise) * BigInt(num);
  const d = BigInt(den);
  let q = x / d; // truncates toward zero
  const r = x - q * d;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice > d || (twice === d && q % 2n !== 0n)) q += x < 0n ? -1n : 1n;
  return Number(q);
}

interface ShareInfo {
  ownerId: string;
  /** Every member who ever held it, with their stretches. */
  members: Map<string, Stretch[]>;
  /** Changes ascending by date: each holder's basis points from that date. */
  changes: { from: string; bp: Map<string, number> }[];
}

export async function sharesFor(db: AppDb, userId: string, accountIds: readonly string[]): Promise<ViewerShares> {
  const info = new Map<string, ShareInfo>();
  const stretches = memberStretches(db, accountIds);
  if (stretches.size > 0) {
    const sharedIds = [...stretches.keys()];
    const owners = db
      .select({ id: schema.accounts.id, ownerId: schema.accounts.ownerId })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, sharedIds))
      .all();
    for (const o of owners) {
      const members = new Map(stretches.get(o.id) ?? []);
      members.delete(o.ownerId);
      info.set(o.id, { ownerId: o.ownerId, members, changes: [] });
    }
    const rows = db
      .select()
      .from(schema.accountShares)
      .where(inArray(schema.accountShares.accountId, sharedIds))
      .orderBy(asc(schema.accountShares.effectiveFrom))
      .all();
    for (const r of rows) {
      const i = info.get(r.accountId);
      if (!i) continue;
      let last = i.changes[i.changes.length - 1];
      if (!last || last.from !== r.effectiveFrom) {
        last = { from: r.effectiveFrom, bp: new Map() };
        i.changes.push(last);
      }
      last.bp.set(r.userId, r.shareBp);
    }
  }

  const holdsOn = (i: ShareInfo, holder: string, date: string): boolean =>
    holder === i.ownerId || inStretches(i.members.get(holder) ?? [], date);
  const holdersOn = (i: ShareInfo, date: string): string[] =>
    [i.ownerId, ...[...i.members.keys()].filter((m) => holdsOn(i, m, date))];
  const changeOn = (i: ShareInfo, date: string) => {
    let found: ShareInfo['changes'][number] | undefined;
    for (const c of i.changes) {
      if (c.from <= date) found = c;
      else break;
    }
    return found;
  };
  /** The viewer's part of `paise` on `date`, from who held the account that day and its split. */
  const partAt = (accountId: string, paise: number, date: string): number => {
    const i = info.get(accountId);
    if (!i) return paise;
    if (!holdsOn(i, userId, date)) return 0;
    const holders = holdersOn(i, date);
    if (holders.length < 2) return paise;
    const change = changeOn(i, date);
    const fraction = (h: string): [number, number] => (change ? [change.bp.get(h) ?? 0, 10_000] : [1, holders.length]);
    if (userId !== i.ownerId) return halfEvenPart(paise, ...fraction(userId));
    let others = 0;
    for (const h of holders) if (h !== i.ownerId) others += halfEvenPart(paise, ...fraction(h));
    return paise - others;
  };

  return {
    isShared: (accountId, date) => {
      const i = info.get(accountId);
      return i !== undefined && holdersOn(i, date ?? formatDate(today(appClock()))).length > 1;
    },
    partIn: (accountId, paise, period) => partAt(accountId, paise, period ?? SINCE_START),
    partOn: partAt,
    shareBpOn: (accountId, date) => partAt(accountId, 10_000, date),
    changeDates: (accountId) => {
      const i = info.get(accountId);
      if (!i) return [];
      const dates = new Set<string>(i.changes.map((c) => c.from));
      for (const list of i.members.values()) {
        for (const s of list) {
          if (s.from !== SINCE_START) dates.add(s.from);
          if (s.to !== null) dates.add(s.to);
        }
      }
      return [...dates].sort();
    },
  };
}
