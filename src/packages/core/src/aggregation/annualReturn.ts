/**
 * annualReturn.ts: a holding's return per year (XIRR "since tracking", S2 RD6), and the
 * value / invested series behind the holdings chart (S2 RD7, chart I1).
 *
 * Reads ONLY the contract through the registry (`currentValue`, `costBasis`, `cashFlows`,
 * `metadata.side`): no module import, no `if (type === …)`, no contract change.
 *
 * The flows (S2 RD6, money-weighted, the standard XIRR form), as the investor sees them:
 *   - a START flow of minus the holding's value at the end of its start day (its opening plus
 *     anything on that day, so an initial mark counts as value already there, not as return);
 *   - each later day's EXTERNAL flows, from `cashFlows` asked one day at a time (transfer legs
 *     only; a mark is not a cash flow): money put in is negative, money taken out positive;
 *   - an END flow of plus the value at the end day.
 * Day count actual/365. Solved by Newton's method with a bisection fallback.
 *
 * `null` ("—") when the window is under one year (SEBI: no annualising a sub-year return), when
 * the flows can't have a rate (no money in or no money out), or when the solver finds no root.
 * Liabilities have no return per year (assets only, by `side`).
 */
import { getModule } from './registry.js';
import { compareDates, formatDate } from '../date.js';
import type { PlainDate } from '../date.js';
import type { AccountView } from './contract.js';
import type { Transaction } from '../transaction.js';

/** One dated cash flow in paise, from the investor's side (put in < 0, taken out or held > 0). */
export interface DatedFlow {
  readonly date: PlainDate;
  readonly paise: number;
}

/** A holding's flows over `[start, end]`, for one return per year or several merged (a section). */
export interface HoldingFlows {
  readonly start: PlainDate;
  readonly end: PlainDate;
  readonly flows: DatedFlow[];
}

const DAYS_A_YEAR = 365;

function daysBetween(a: PlainDate, b: PlainDate): number {
  return a.until(b, { largestUnit: 'days' }).days;
}

/**
 * Whether a row tells the holding's value (the red team's rule 3): a valuation
 * mark, of any amount (a matching update records a ₹0 row), or growth typed inside the
 * holding, a plain row that counts as return with a positive amount (interest, a dividend). Money
 * moved and losses don't confirm a value.
 */
export function setsValue(tx: Transaction): boolean {
  if (tx.kind === 'valuationMark') return true;
  const transfer = tx.transferPartnerId !== undefined && tx.transferPartnerId !== null;
  return !transfer && tx.countsAsReturn !== false && tx.amount.paise > 0;
}

/**
 * The date of the holding's last row that tells its value (`setsValue`) in `(after, asOf]`, or
 * null when it has none. The value is only known there, so a holding's return per year ends there,
 * on its register and its section alike (S2 RD6, RD12).
 */
export function lastValueDate(account: AccountView, after: PlainDate, asOf: PlainDate): PlainDate | null {
  let last: PlainDate | null = null;
  for (const tx of account.transactions) {
    if (!setsValue(tx)) continue;
    if (compareDates(tx.date, after) <= 0 || compareDates(tx.date, asOf) > 0) continue;
    if (last === null || compareDates(tx.date, last) > 0) last = tx.date;
  }
  return last;
}

/** A growth row of any sign: a value update, or a plain row that counts as return (a write-off too). */
function isGrowthRow(tx: Transaction): boolean {
  if (tx.kind === 'valuationMark') return true;
  const transfer = tx.transferPartnerId !== undefined && tx.transferPartnerId !== null;
  return !transfer && tx.countsAsReturn !== false;
}

/**
 * Where a CLOSED holding's return per year ends (the red team's rule 4): at its last
 * value-setting row, as an open one (rule 3), so Pay and close months after the last interest row
 * doesn't change the rate; but at its last row (the close) when a loss or adjustment comes after
 * that (a write-off), or when it never had a value row (a fund bought and sold, no updates).
 * Null when it has no row in `(after, asOf]`.
 */
export function closedEndDate(account: AccountView, after: PlainDate, asOf: PlainDate): PlainDate | null {
  let lastRow: PlainDate | null = null;
  let lastLoss: PlainDate | null = null;
  for (const tx of account.transactions) {
    if (compareDates(tx.date, after) <= 0 || compareDates(tx.date, asOf) > 0) continue;
    if (lastRow === null || compareDates(tx.date, lastRow) > 0) lastRow = tx.date;
    if (isGrowthRow(tx) && !setsValue(tx) && (lastLoss === null || compareDates(tx.date, lastLoss) > 0)) lastLoss = tx.date;
  }
  const lastValue = lastValueDate(account, after, asOf);
  if (lastValue === null) return lastRow;
  return lastLoss !== null && compareDates(lastLoss, lastValue) > 0 ? lastRow : lastValue;
}

/**
 * What an ASSET holding earned up to `asOf`, money out minus money in (rule 4): its
 * value then, plus everything taken out, minus its opening and everything put in. On a closed
 * holding (value 0) that is what it made over its life, realised gain included: an FD of ₹1,00,000
 * paid out at ₹1,14,490 earned ₹14,490; one written off lost ₹1,00,000. Null for a liability.
 * Reads the contract only (`currentValue`, `cashFlows`, `metadata.side`).
 */
export function holdingEarned(account: AccountView, asOf: PlainDate): number | null {
  const module = getModule(account.type);
  if (module.metadata.side !== 'Asset') return null;
  let first: PlainDate = asOf;
  for (const tx of account.transactions) if (compareDates(tx.date, first) < 0) first = tx.date;
  const cf = module.cashFlows(account, { from: first, to: asOf });
  return module.currentValue(account, asOf).paise + cf.outflow.paise - cf.inflow.paise - account.opening.paise;
}

/**
 * The investor's flows for one ASSET holding from `start` to `end` (see the header). Null for a
 * liability, or when `end` is not after `start`.
 */
export function holdingFlows(account: AccountView, start: PlainDate, end: PlainDate): HoldingFlows | null {
  const module = getModule(account.type);
  if (module.metadata.side !== 'Asset') return null;
  if (compareDates(end, start) <= 0) return null;

  const flows: DatedFlow[] = [];
  const startValue = module.currentValue(account, start).paise;
  if (startValue !== 0) flows.push({ date: start, paise: -startValue });

  const days = new Map<string, PlainDate>();
  for (const tx of account.transactions) {
    if (compareDates(tx.date, start) <= 0 || compareDates(tx.date, end) > 0) continue;
    days.set(formatDate(tx.date), tx.date);
  }
  for (const day of [...days.values()].sort(compareDates)) {
    const cf = module.cashFlows(account, { from: day, to: day });
    const net = cf.inflow.paise - cf.outflow.paise;
    if (net !== 0) flows.push({ date: day, paise: -net });
  }

  const endValue = module.currentValue(account, end).paise;
  if (endValue !== 0) flows.push({ date: end, paise: endValue });
  return { start, end, flows };
}

/**
 * The rate `r` with Σ flow × (1 + r)^(−days/365) = 0, or null when there is none (all flows one
 * sign, or no root). Newton's method from 10 %, then bisection over (−99.99 %, 100 000 %).
 */
export function xirr(flows: readonly DatedFlow[]): number | null {
  if (flows.length < 2) return null;
  if (!flows.some((f) => f.paise > 0) || !flows.some((f) => f.paise < 0)) return null;
  const t0 = flows.reduce((min, f) => (compareDates(f.date, min) < 0 ? f.date : min), flows[0]!.date);
  const terms = flows.map((f) => ({ amount: f.paise, years: daysBetween(t0, f.date) / DAYS_A_YEAR }));
  const npv = (r: number) => terms.reduce((s, t) => s + t.amount / Math.pow(1 + r, t.years), 0);
  const slope = (r: number) => terms.reduce((s, t) => s - (t.years * t.amount) / Math.pow(1 + r, t.years + 1), 0);
  const scale = terms.reduce((s, t) => s + Math.abs(t.amount), 0);

  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const f = npv(r);
    if (Math.abs(f) < scale * 1e-12) return r;
    const d = slope(r);
    if (!Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }

  let lo = -0.9999;
  let hi = 1000;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || Math.sign(flo) === Math.sign(fhi)) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

/**
 * Return per year over one holding's or several holdings' flows merged by day (a section; S2 RD6
 * allows it only when they share one currency, which the caller checks). Null under one year from
 * the earliest start to the latest end.
 */
export function annualReturn(holdings: readonly HoldingFlows[]): number | null {
  if (holdings.length === 0) return null;
  let start = holdings[0]!.start;
  let end = holdings[0]!.end;
  const byDay = new Map<string, DatedFlow>();
  for (const h of holdings) {
    if (compareDates(h.start, start) < 0) start = h.start;
    if (compareDates(h.end, end) > 0) end = h.end;
    for (const f of h.flows) {
      const key = formatDate(f.date);
      byDay.set(key, { date: f.date, paise: (byDay.get(key)?.paise ?? 0) + f.paise });
    }
  }
  if (daysBetween(start, end) < DAYS_A_YEAR) return null;
  return xirr([...byDay.values()].filter((f) => f.paise !== 0).sort((a, b) => compareDates(a.date, b.date)));
}

/** One point of the holdings chart: what it was worth and what had been put in. */
export interface ValueInvestedPoint {
  readonly date: PlainDate;
  readonly valuePaise: number;
  readonly investedPaise: number;
}

/** A holding's value and invested amount (cost basis) at each of `points`, in its own currency. */
export function valueInvestedSeries(account: AccountView, points: readonly PlainDate[]): ValueInvestedPoint[] {
  const module = getModule(account.type);
  return points.map((date) => ({
    date,
    valuePaise: module.currentValue(account, date).paise,
    investedPaise: module.costBasis(account, date).paise,
  }));
}
