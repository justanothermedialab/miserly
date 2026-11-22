import { describe, expect, it } from 'vitest';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import { compareTransactions, nextSequence, sortTransactions } from '../src/ordering.js';
import type { Transaction } from '../src/transaction.js';

function tx(id: string, dateIso: string, sequence: number): Transaction {
  return {
    id,
    accountId: 'acc-1',
    date: parseDate(dateIso),
    sequence,
    amount: Money.fromPaise(0, 'INR'),
  };
}

describe('ordering: sortTransactions', () => {
  it('orders by (date, sequence), never by insert position or id', () => {
    const input: Transaction[] = [
      tx('c', '2024-01-03', 0),
      tx('a', '2024-01-01', 1),
      tx('b', '2024-01-01', 0),
    ];
    const sorted = sortTransactions(input);
    expect(sorted.map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const input: Transaction[] = [tx('b', '2024-01-02', 0), tx('a', '2024-01-01', 0)];
    const copy = [...input];
    sortTransactions(input);
    expect(input).toEqual(copy);
  });
});

describe('ordering: compareTransactions', () => {
  it('is a total order tiebroken by sequence within the same date', () => {
    const a = tx('a', '2024-01-01', 0);
    const b = tx('b', '2024-01-01', 1);
    expect(compareTransactions(a, b)).toBe(-1);
    expect(compareTransactions(b, a)).toBe(1);
    expect(compareTransactions(a, a)).toBe(0);
  });
});

describe('ordering: nextSequence', () => {
  it('is 0 for an empty date bucket', () => {
    expect(nextSequence([])).toBe(0);
  });

  it('is one past the current max sequence', () => {
    const existing = [tx('a', '2024-01-01', 0), tx('b', '2024-01-01', 3), tx('c', '2024-01-01', 1)];
    expect(nextSequence(existing)).toBe(4);
  });
});
