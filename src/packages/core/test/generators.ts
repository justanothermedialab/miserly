/**
 * Shared fast-check generators for the M1 property tests. Not a test file
 * itself (excluded by vitest's `test/**\/*.test.ts` include pattern).
 */
import fc from 'fast-check';
import { parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import type { Transaction } from '../src/transaction.js';

export const CURRENCY = 'INR';

/**
 * A SMALL pool of dates so the generator produces frequent same-date
 * collisions (dense same-date clusters), not just spread-out dates.
 */
export const DATE_POOL = [
  '2024-01-01',
  '2024-01-02',
  '2024-01-03',
  '2024-01-04',
  '2024-01-05',
] as const;

/** Strictly earlier than every date in DATE_POOL — used for back-dated-insert tests. */
export const BEFORE_POOL_DATE_ISO = '2023-06-15';

export function makeTx(params: {
  id: string;
  dateIso: string;
  sequence: number;
  paise: number;
}): Transaction {
  return {
    id: params.id,
    accountId: 'acc-1',
    date: parseDate(params.dateIso),
    sequence: params.sequence,
    amount: Money.fromPaise(params.paise, CURRENCY),
  };
}

/** Positive, negative, zero, and large-magnitude paise amounts. */
export const paiseArb = fc.integer({ min: -1_000_000_00, max: 1_000_000_00 });

/** A date drawn from the small pool above, to force frequent collisions. */
export const dateIsoArb = fc.constantFrom<string>(...DATE_POOL);

/**
 * An array of transactions with unique ids and, within each date bucket,
 * monotonically-assigned unique sequence numbers (0, 1, 2, … per date).
 * Dates are drawn from the small pool, so same-date clustering is frequent
 * by construction.
 */
export const transactionsArb: fc.Arbitrary<Transaction[]> = fc
  .array(fc.record({ dateIso: dateIsoArb, paise: paiseArb }), { minLength: 0, maxLength: 40 })
  .map((entries) => {
    const seqByDate = new Map<string, number>();
    return entries.map((entry, index) => {
      const seq = seqByDate.get(entry.dateIso) ?? 0;
      seqByDate.set(entry.dateIso, seq + 1);
      return makeTx({ id: `tx-${index}`, dateIso: entry.dateIso, sequence: seq, paise: entry.paise });
    });
  });

/** Same as `transactionsArb` but guarantees at least one transaction. */
export const nonEmptyTransactionsArb: fc.Arbitrary<Transaction[]> = fc
  .array(fc.record({ dateIso: dateIsoArb, paise: paiseArb }), { minLength: 1, maxLength: 40 })
  .map((entries) => {
    const seqByDate = new Map<string, number>();
    return entries.map((entry, index) => {
      const seq = seqByDate.get(entry.dateIso) ?? 0;
      seqByDate.set(entry.dateIso, seq + 1);
      return makeTx({ id: `tx-${index}`, dateIso: entry.dateIso, sequence: seq, paise: entry.paise });
    });
  });

export const openingArb: fc.Arbitrary<Money> = fc
  .integer({ min: -10_000_000_00, max: 10_000_000_00 })
  .map((paise) => Money.fromPaise(paise, CURRENCY));

/**
 * A shared "dense same-date cluster" generator: many rows on a SINGLE fixed
 * date, each with a distinct sequence 0..n-1 and an arbitrary paise amount.
 * Used to test same-date reordering.
 */
export const sameDateAmountsArb: fc.Arbitrary<number[]> = fc.array(paiseArb, {
  minLength: 2,
  maxLength: 20,
});
