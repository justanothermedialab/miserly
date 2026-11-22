/**
 * Example-based (hand-worked) tests for ledger.ts, complementing the
 * property tests in ledger.property.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import { balanceAsOf, orderedBalance, projectedBalance, runningBalances } from '../src/ledger.js';
import type { Transaction } from '../src/transaction.js';

const INR = 'INR';
const rupees = (r: number) => Money.fromPaise(r * 100, INR);

function tx(id: string, dateIso: string, sequence: number, amountPaise: number): Transaction {
  return {
    id,
    accountId: 'acc-1',
    date: parseDate(dateIso),
    sequence,
    amount: Money.fromPaise(amountPaise, INR),
  };
}

describe('ledger: hand-worked back-dated insert', () => {
  it('shifts every later running balance when an earlier-dated row is inserted', () => {
    const opening = rupees(1000);

    // Original ledger: Jan 2 (+500), Jan 3 (-200).
    const original: Transaction[] = [
      tx('a', '2024-01-02', 0, 50_00),
      tx('b', '2024-01-03', 0, -20_00),
    ];

    const originalRows = runningBalances(opening, original);
    expect(originalRows.map((r) => r.balance.paise)).toEqual([
      1000_00 + 50_00, // 1050
      1000_00 + 50_00 - 20_00, // 1030
    ]);

    // Now back-date-insert a Jan 1 transaction of +100.
    const withBackdated: Transaction[] = [...original, tx('c', '2024-01-01', 0, 100_00)];
    const rows = runningBalances(opening, withBackdated);

    // 'c' must come FIRST (earliest date), shifting every subsequent balance.
    expect(rows.map((r) => r.transaction.id)).toEqual(['c', 'a', 'b']);
    expect(rows.map((r) => r.balance.paise)).toEqual([
      1000_00 + 100_00, // 1100 (c)
      1000_00 + 100_00 + 50_00, // 1150 (a)
      1000_00 + 100_00 + 50_00 - 20_00, // 1130 (b)
    ]);

    // Final/ordered balance reflects the inserted row.
    expect(orderedBalance(opening, withBackdated).paise).toBe(1130_00);
  });
});

describe('ledger: hand-worked same-date reorder (Actual #3928 shape)', () => {
  it('two transactions on the SAME date give the same final balance under either ordering, with different intermediate balances', () => {
    const opening = rupees(0);

    // Ordering A: sequence 0 = +300, sequence 1 = -100.
    const orderingA: Transaction[] = [
      tx('x', '2024-05-01', 0, 300_00),
      tx('y', '2024-05-01', 1, -100_00),
    ];
    // Ordering B: the same two amounts, sequences swapped.
    const orderingB: Transaction[] = [
      tx('y', '2024-05-01', 0, -100_00),
      tx('x', '2024-05-01', 1, 300_00),
    ];

    const rowsA = runningBalances(opening, orderingA);
    const rowsB = runningBalances(opening, orderingB);

    // Intermediate (first-row) balances differ between the two orderings.
    expect(rowsA[0]!.balance.paise).toBe(300_00);
    expect(rowsB[0]!.balance.paise).toBe(-100_00);
    expect(rowsA[0]!.balance.paise).not.toBe(rowsB[0]!.balance.paise);

    // Final balances are identical (200) regardless of ordering.
    expect(rowsA[rowsA.length - 1]!.balance.paise).toBe(200_00);
    expect(rowsB[rowsB.length - 1]!.balance.paise).toBe(200_00);
    expect(orderedBalance(opening, orderingA).equals(orderedBalance(opening, orderingB))).toBe(
      true,
    );
  });
});

describe('ledger: as-of vs projected', () => {
  it('excludes future-dated rows from balanceAsOf but includes them in projectedBalance', () => {
    const opening = rupees(0);
    const txs: Transaction[] = [
      tx('past', '2024-01-01', 0, 100_00),
      tx('today', '2024-01-15', 0, 50_00),
      tx('future', '2024-02-01', 0, -30_00),
    ];
    const asOf = parseDate('2024-01-15');

    expect(balanceAsOf(opening, txs, asOf).paise).toBe(150_00);
    expect(projectedBalance(opening, txs).paise).toBe(120_00);
    expect(orderedBalance(opening, txs).paise).toBe(120_00);
  });

  it('does not use insert position: appending an out-of-order row still derives correctly', () => {
    const opening = rupees(0);
    // Deliberately appended in a NON-chronological insert order.
    const txs: Transaction[] = [
      tx('third', '2024-03-01', 0, 10_00),
      tx('first', '2024-01-01', 0, 100_00),
      tx('second', '2024-02-01', 0, -40_00),
    ];
    const rows = runningBalances(opening, txs);
    expect(rows.map((r) => r.transaction.id)).toEqual(['first', 'second', 'third']);
    expect(rows.map((r) => r.balance.paise)).toEqual([100_00, 60_00, 70_00]);
  });
});
