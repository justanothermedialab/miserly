/**
 * history.ts — net-worth-over-time (D3).
 *
 * Reads ONLY the contract + the module registry (same boundary rule as
 * networth.ts) — never a concrete module, never an `if (type === …)`.
 *
 * Two things make D3 differ from the as-of-today aggregates (D1/D2), and both
 * are honored HERE, not by mutating the frozen contract:
 *
 *  1. Closed accounts count for the periods they were open. So the series
 *     fold does NOT skip `status === 'closed'` the way `netWorth` does — it
 *     sums `currentValue` over EVERY view the caller supplies. A force-closed
 *     account carries a zeroing adjustment in its ledger, so its
 *     `currentValue` is its real balance before the close date and 0 after —
 *     the correct history falls straight out of `balanceAsOf`, no special
 *     casing. The CALLER (the web service) decides the view set: the viewer's
 *     visible accounts including the closed ones they held (D3 scope clause).
 *
 *  2. Dated opening (F1 RD10): an account contributes 0 to any month before it
 *     existed. `AccountView` carries no `openingDate` (that lives in the DB,
 *     and the contract is frozen), so the caller passes an `existsAsOf`
 *     predicate — typically `openingDate[id] <= asOf`. A view that doesn't yet
 *     exist at a point is simply omitted from that point's sum (its opening
 *     must not leak into a month before it was opened). Default: always exists.
 *
 * The latest point uses "today" as its as-of date (the caller passes it as the
 * final month-end), so the last point equals the D1 hero exactly — the
 * divergence that would be a P0.
 *
 * Date arithmetic uses `Temporal.PlainDate` directly. That keeps the module
 * pure/deterministic (Temporal calendar math reads no clock); "today" still
 * enters only via a caller-injected date, never `Temporal.Now`.
 */
import { getModule } from './registry.js';
import { Money } from '../money.js';
import type { CurrencyCode } from '../money.js';
import { toBase } from '../fx.js';
import type { RateTable } from '../fx.js';
import { compareDates } from '../date.js';
import type { PlainDate } from '../date.js';
import type { AccountView } from './contract.js';
import type { Aggregated } from './networth.js';

/** One month-end (or the current-day) sample of net worth and its asset/liability split. */
export interface NetWorthPoint {
  readonly date: PlainDate;
  readonly netWorth: Money;
  readonly assets: Money;
  readonly liabilities: Money;
}

/** Last calendar day of the month `d` falls in. */
function lastDayOfMonth(d: PlainDate): PlainDate {
  return d.with({ day: d.daysInMonth });
}

/**
 * The month-end sample dates for the window `[from, to]`, ascending, with `to`
 * itself as the final point (so the current-month sample is "today", not a
 * future month-end). Every intervening calendar month contributes its last
 * day. A window shorter than a month yields just `[to]` — D3's "< 2 months"
 * graceful state is a display concern the caller handles.
 *
 * `from > to` yields `[]`.
 */
export function monthEndPoints(from: PlainDate, to: PlainDate): PlainDate[] {
  if (compareDates(from, to) > 0) return [];
  const points: PlainDate[] = [];
  let cursor = lastDayOfMonth(from);
  // Every month-end strictly before `to`'s month-end is a historical sample;
  // `to` is appended last as the current point (it may itself be a month-end,
  // in which case it is not duplicated because the loop stops before it).
  while (compareDates(cursor, to) < 0) {
    points.push(cursor);
    cursor = lastDayOfMonth(cursor.with({ day: 1 }).add({ months: 1 }));
  }
  points.push(to);
  return points;
}

/**
 * Predicate deciding whether an account is in scope at a given as-of date.
 * Used to honor F1 RD10 (dated opening) — see the module header.
 */
export type ExistsAsOf = (account: AccountView, asOf: PlainDate) => boolean;

/**
 * Net worth (+ asset/liability split) at each of `points`, summing
 * `currentValue` — converted to base through the single `toBase` boundary
 * (M9 / MC1) — over the supplied accounts, with NO status skip (closed accounts
 * count for the periods they were open). `existsAsOf` gates dated opening.
 *
 * A foreign currency with no rate is excluded from every point and recorded in
 * `rateNeeded` (the union across points), so an incomplete history is flagged
 * rather than silently computed at 1:1 — matching the D1/D2 folds. MVP applies
 * the SINGLE current rate across all of history (MC1: "historical FX = today's
 * rate"); dated period-correct rates are v2.
 *
 * `netWorth === assets.add(liabilities)` at every point by construction
 * (`liabilities` carries the natural-negative side, both exclude the same
 * unrated accounts), so the split can never disagree with the line.
 */
export function netWorthSeries(
  points: readonly PlainDate[],
  accounts: readonly AccountView[],
  rates: RateTable,
  existsAsOf: ExistsAsOf = () => true,
): Aggregated<NetWorthPoint[]> {
  const missing = new Set<CurrencyCode>();
  const series = points.map((asOf) => {
    let assets = Money.zero(rates.base);
    let liabilities = Money.zero(rates.base);
    for (const account of accounts) {
      if (!existsAsOf(account, asOf)) continue;
      const module = getModule(account.type);
      const converted = toBase(module.currentValue(account, asOf), rates);
      if (converted === null) {
        missing.add(account.currency);
        continue;
      }
      if (module.metadata.side === 'Asset') {
        assets = assets.add(converted);
      } else {
        liabilities = liabilities.add(converted);
      }
    }
    return { date: asOf, netWorth: assets.add(liabilities), assets, liabilities };
  });
  return { result: series, rateNeeded: missing };
}
