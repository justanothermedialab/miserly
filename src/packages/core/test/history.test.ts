/**
 * Tests for aggregation/history.ts (D3 net-worth-over-time).
 *
 * The two D3-specific behaviours are the focus: closed accounts count for the
 * periods they were open (no status skip), and dated opening (F1 RD10) is
 * honored via the `existsAsOf` predicate. Plus the invariant that the latest
 * point equals the D1 as-of-today figure.
 */
import { describe, expect, it } from 'vitest';
import '../src/modules/index.js';
import { compareDates, parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import { netWorth } from '../src/aggregation/networth.js';
import { monthEndPoints, netWorthSeries } from '../src/aggregation/history.js';
import { rateTable } from '../src/fx.js';
import type { AccountView } from '../src/aggregation/contract.js';
import type { Transaction } from '../src/transaction.js';

const INR = 'INR';
/** All-INR base table (no foreign rates) — every value converts ×1. */
const INR_RATES = rateTable(INR);

function tx(id: string, dateIso: string, amountPaise: number): Transaction {
  return {
    id,
    accountId: 'acc',
    date: parseDate(dateIso),
    sequence: 0,
    amount: Money.fromPaise(amountPaise, INR),
  };
}

function bank(id: string, status: 'open' | 'closed', txs: Transaction[]): AccountView {
  return { id, type: 'bank', currency: INR, status, opening: Money.zero(INR), transactions: txs };
}

describe('monthEndPoints', () => {
  it('emits each intervening month-end and ends on `to` (the current point)', () => {
    const points = monthEndPoints(parseDate('2024-01-10'), parseDate('2024-03-15')).map((d) =>
      d.toString(),
    );
    expect(points).toEqual(['2024-01-31', '2024-02-29', '2024-03-15']);
  });

  it('does not duplicate `to` when it is itself a month-end', () => {
    const points = monthEndPoints(parseDate('2024-01-10'), parseDate('2024-03-31')).map((d) =>
      d.toString(),
    );
    expect(points).toEqual(['2024-01-31', '2024-02-29', '2024-03-31']);
  });

  it('crosses a year boundary correctly', () => {
    const points = monthEndPoints(parseDate('2023-11-05'), parseDate('2024-01-20')).map((d) =>
      d.toString(),
    );
    expect(points).toEqual(['2023-11-30', '2023-12-31', '2024-01-20']);
  });

  it('a sub-month window yields a single point (the "< 2 months" graceful state)', () => {
    const points = monthEndPoints(parseDate('2024-03-05'), parseDate('2024-03-20')).map((d) =>
      d.toString(),
    );
    expect(points).toEqual(['2024-03-20']);
  });

  it('from > to yields no points', () => {
    expect(monthEndPoints(parseDate('2024-05-01'), parseDate('2024-04-01'))).toEqual([]);
  });
});

describe('netWorthSeries', () => {
  const points = monthEndPoints(parseDate('2024-01-10'), parseDate('2024-03-15'));

  it('steps the line at the date each transaction is dated', () => {
    // +1000 on Jan 20, +500 on Mar 1
    const acc = bank('b1', 'open', [tx('t1', '2024-01-20', 100000), tx('t2', '2024-03-01', 50000)]);
    const series = netWorthSeries(points, [acc], INR_RATES).result;
    expect(series.map((p) => p.netWorth.paise)).toEqual([100000, 100000, 150000]);
  });

  it('netWorth === assets + liabilities at every point', () => {
    const asset = bank('b1', 'open', [tx('t1', '2024-01-20', 100000)]);
    const liab: AccountView = {
      id: 'cc',
      type: 'creditCard',
      currency: INR,
      status: 'open',
      opening: Money.zero(INR),
      transactions: [tx('t2', '2024-02-01', -30000)],
    };
    for (const p of netWorthSeries(points, [asset, liab], INR_RATES).result) {
      expect(p.netWorth.paise).toBe(p.assets.paise + p.liabilities.paise);
    }
  });

  it('counts a CLOSED account for the months it was open, then 0 after its zeroing close', () => {
    // Opened with +1000 on Jan 20, force-closed Feb 10 (zeroing -1000), status now closed.
    const closed = bank('b1', 'closed', [
      tx('t1', '2024-01-20', 100000),
      tx('close', '2024-02-10', -100000),
    ]);
    const series = netWorthSeries(points, [closed], INR_RATES).result;
    // Jan-31: had 1000. Feb-29: zeroed to 0. Mar-15: still 0. (Contrast netWorth, which drops it entirely.)
    expect(series.map((p) => p.netWorth.paise)).toEqual([100000, 0, 0]);
  });

  it('honors dated opening (RD10): an account contributes 0 before it existed', () => {
    // Account "exists" only from Feb 15 (opening_date), opening 2000 as a column (no tx).
    const acc: AccountView = {
      id: 'b1',
      type: 'bank',
      currency: INR,
      status: 'open',
      opening: Money.fromPaise(200000, INR),
      transactions: [],
    };
    const openingDate = parseDate('2024-02-15');
    const existsAsOf = (_a: AccountView, asOf: ReturnType<typeof parseDate>) =>
      compareDates(openingDate, asOf) <= 0;
    const series = netWorthSeries(points, [acc], INR_RATES, existsAsOf).result;
    // Jan-31: didn't exist → 0 (opening must NOT leak). Feb-29 & Mar-15: 2000.
    expect(series.map((p) => p.netWorth.paise)).toEqual([0, 200000, 200000]);
  });

  it('latest point equals the D1 as-of-today net worth (open ∪ zeroed-closed all reconcile)', () => {
    const today = parseDate('2024-03-15');
    const open = bank('b1', 'open', [tx('t1', '2024-01-20', 100000)]);
    const closedZeroed = bank('b2', 'closed', [
      tx('t2', '2024-01-05', 40000),
      tx('c', '2024-02-01', -40000),
    ]);
    const series = netWorthSeries(monthEndPoints(parseDate('2024-01-10'), today), [open, closedZeroed], INR_RATES).result;
    const latest = series.at(-1);
    // D1 hero = netWorth over OPEN accounts only at today.
    expect(latest?.netWorth.paise).toBe(netWorth([open, closedZeroed], today, INR_RATES).result.paise);
  });
});
