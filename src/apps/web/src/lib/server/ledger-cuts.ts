/**
 * ledger-cuts.ts: every account's balance at the dates a figure needs, in one grouped SQL sum.
 * ============================================================================
 * Balances stay derived on read (architecture: balance = opening + Σ its rows; nothing stored).
 * What changed is where the Σ happens: the sidebar, the dashboard and the charts read every row of
 * every account into JavaScript, parsed each date into a Temporal date and folded them, on every
 * page (about 250 ms a page at 5,000 rows on the laptop, 400 on a low-power server). Here SQL sums each
 * account's live rows between the dates asked for ("cuts"), one grouped query for all accounts.
 *
 * The engine still values every account through its module (`currentValue`, the aggregation
 * contract): `cutViews` hands it a view whose rows are those sums, one row per cut, dated at the
 * cut. A module's value is its balance as of the date (ledger- and holding-valued alike), so the
 * view of sums values the same as the view of every row at each cut; `ledger-cuts.property.test.ts`
 * holds every registered module to that, so a module that ever reads more than the balance fails
 * there first. Such a view is only good for values at its cuts: never for cost basis, flows or
 * returns, which still read the rows (`holdingMetrics` and the rest).
 *
 * A stored date that isn't a day of the calendar (hosted audit H2) is read as the engine reads it,
 * the nearest real day of its month (`parseStoredDate`): SQL sums only the real ones and returns
 * the rest one by one, which JavaScript places (none, almost always).
 * ============================================================================
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database, Statement } from 'better-sqlite3';
import { Money, formatDate } from '@miserly/core';
import type { AccountView, PlainDate, Transaction } from '@miserly/core';
import type * as schema from './db/schema';
import { parseStoredDate } from './db/mappers';

type AccountRow = typeof schema.accounts.$inferSelect;

/** Each account's live rows summed between the cuts. */
export interface LedgerCuts {
  /** The cuts (ISO dates, ascending) the sums are taken at. */
  readonly cuts: readonly string[];
  /** Per account (only those with live rows): `sums[i]` is the Σ of rows dated after `cuts[i-1]`
   *  and on or before `cuts[i]`; the last entry, `sums[cuts.length]`, the rows after the last cut. */
  readonly sums: ReadonlyMap<string, readonly number[]>;
  /** Per account: its first and last live row's date, as the engine reads them (real days). */
  readonly first: ReadonlyMap<string, string>;
  readonly last: ReadonlyMap<string, string>;
}

/**
 * The cuts every "today" figure asks for: the last month end and today. The sidebar's change this
 * month, Accounts' and the sections' changes need the month end, so asking for both everywhere
 * lets one request sum the ledger once (`inLedgerScope`).
 */
export function todayCuts(today: PlainDate): string[] {
  return [formatDate(today.with({ day: 1 }).subtract({ days: 1 })), formatDate(today)];
}

/** The bucket of a (real) ISO date among ascending cuts: the first cut on or after it. */
function bucketOf(iso: string, cuts: readonly string[]): number {
  let i = 0;
  while (i < cuts.length && iso > cuts[i]!) i++;
  return i;
}

/**
 * One request's sums, so the layout and the page sum the ledger once: `inLedgerScope` runs a
 * request (hooks.server.ts), and a later ask for cuts among those an earlier one summed, over the
 * same accounts, is cut from that result (`narrow`). Keyed by SQLite's `total_changes()`, so
 * anything written in between (a form posted without JavaScript saves, then the page loads) is
 * summed afresh. Outside a request (tests, scripts) nothing is kept.
 */
const scope = new AsyncLocalStorage<Map<string, LedgerCuts[]>>();
const changesStmt = new WeakMap<Database, Statement>();

/** Run `fn` (a request) with its own ledger sums. */
export function inLedgerScope<T>(fn: () => T): T {
  return scope.run(new Map(), fn);
}

/** The cuts of `from` re-summed at `cuts`, a subset of its own (both ascending). */
function narrow(from: LedgerCuts, cuts: readonly string[]): LedgerCuts {
  // Each of `from`'s buckets lands whole in one of the new ones: the first new cut on or after its
  // own cut (its rows are after the cut before, which is on or after the new cut before).
  const to = from.cuts.map((c) => bucketOf(c, cuts));
  to.push(cuts.length);
  const sums = new Map<string, number[]>();
  for (const [id, s] of from.sums) {
    const out = new Array<number>(cuts.length + 1).fill(0);
    s.forEach((paise, j) => (out[to[j]!]! += paise));
    sums.set(id, out);
  }
  return { cuts, sums, first: from.first, last: from.last };
}

/**
 * The live rows of `ids` summed between `cuts` (ISO dates, ascending, no repeats), with each
 * account's first and last row date: one grouped query, plus one more only when a stored date
 * isn't a real day. `ids` are already the viewer's (the caller's visibility check). Within a
 * request, cut from an earlier sum when it can be (`inLedgerScope`).
 */
export function ledgerCuts(sqlite: Database, ids: readonly string[], cuts: readonly string[]): LedgerCuts {
  const memo = scope.getStore();
  if (memo === undefined || ids.length === 0) return sumCuts(sqlite, ids, cuts);
  let stmt = changesStmt.get(sqlite);
  if (stmt === undefined) changesStmt.set(sqlite, (stmt = sqlite.prepare('SELECT total_changes() AS n')));
  const key = `${(stmt.get() as { n: number }).n}|${[...ids].sort().join(',')}`;
  const done = memo.get(key) ?? [];
  const wanted = new Set(cuts);
  const hit = done.find((d) => cuts.every((c) => d.cuts.includes(c)));
  if (hit !== undefined) return hit.cuts.length === cuts.length && hit.cuts.every((c) => wanted.has(c)) ? hit : narrow(hit, cuts);
  const fresh = sumCuts(sqlite, ids, cuts);
  memo.set(key, [...done, fresh]);
  return fresh;
}

function sumCuts(sqlite: Database, ids: readonly string[], cuts: readonly string[]): LedgerCuts {
  const sums = new Map<string, number[]>();
  const first = new Map<string, string>();
  const last = new Map<string, string>();
  const out: LedgerCuts = { cuts, sums, first, last };
  if (ids.length === 0) return out;
  const params: Record<string, string> = {};
  const idList = ids.map((id, i) => ((params[`a${i}`] = id), `@a${i}`)).join(',');
  cuts.forEach((c, i) => (params[`c${i}`] = c));
  // -1: a stored date that isn't a day of the calendar (`date()` doesn't give it back as stored).
  const bucket = `CASE WHEN date(t.date) IS NOT t.date THEN -1 ${cuts.map((_, i) => `WHEN t.date <= @c${i} THEN ${i}`).join(' ')} ELSE ${cuts.length} END`;
  const groups = sqlite
    .prepare(
      `SELECT b.account_id AS id, b.bucket AS bucket, SUM(b.amount_paise) AS sum, MIN(b.date) AS first, MAX(b.date) AS last
       FROM (SELECT t.account_id, t.amount_paise, t.date, ${bucket} AS bucket
             FROM transactions t
             WHERE t.account_id IN (${idList}) AND t.deleted_at IS NULL) b
       GROUP BY b.account_id, b.bucket`,
    )
    .all(params) as { id: string; bucket: number; sum: number; first: string; last: string }[];

  const add = (id: string, at: number, paise: number, from: string, to: string): void => {
    let s = sums.get(id);
    if (s === undefined) sums.set(id, (s = new Array<number>(cuts.length + 1).fill(0)));
    s[at]! += paise;
    const f = first.get(id);
    if (f === undefined || from < f) first.set(id, from);
    const l = last.get(id);
    if (l === undefined || to > l) last.set(id, to);
  };
  const odd: string[] = [];
  for (const g of groups) {
    if (g.bucket === -1) odd.push(g.id);
    else add(g.id, g.bucket, g.sum, g.first, g.last);
  }
  if (odd.length > 0) {
    const oddParams: Record<string, string> = {};
    const oddList = odd.map((id, i) => ((oddParams[`a${i}`] = id), `@a${i}`)).join(',');
    const rows = sqlite
      .prepare(
        `SELECT t.account_id AS id, t.date AS date, t.amount_paise AS amountPaise FROM transactions t
         WHERE t.account_id IN (${oddList}) AND t.deleted_at IS NULL AND date(t.date) IS NOT t.date`,
      )
      .all(oddParams) as { id: string; date: string; amountPaise: number }[];
    for (const r of rows) {
      // As the engine reads it: the nearest real day (a date it can't read throws there too).
      const real = formatDate(parseStoredDate(r.date));
      add(r.id, bucketOf(real, cuts), r.amountPaise, real, real);
    }
  }
  return out;
}

/**
 * Engine views of `accounts` whose rows are their sums between `cuts` (from `ledgerCuts` over the
 * same dates): one row per non-zero cut, dated at it, and the rows after the last cut as one row
 * dated at the last of them. Valued at a cut, each equals the account's view of every row; good
 * for `currentValue` at the cuts only (see the header).
 */
export function cutViews(accounts: readonly AccountRow[], cuts: readonly PlainDate[], lc: LedgerCuts): AccountView[] {
  return accounts.map((a) => {
    const s = lc.sums.get(a.id);
    const transactions: Transaction[] = [];
    if (s !== undefined) {
      const at = (i: number): PlainDate => (i < cuts.length ? cuts[i]! : parseStoredDate(lc.last.get(a.id)!));
      s.forEach((paise, i) => {
        if (paise !== 0) transactions.push({ id: `${a.id}:${i}`, accountId: a.id, date: at(i), sequence: 0, amount: Money.fromPaise(paise, a.currency) });
      });
    }
    return {
      id: a.id,
      type: a.type,
      currency: a.currency,
      status: a.status,
      opening: Money.fromPaise(a.openingPaise, a.currency),
      transactions,
    };
  });
}
