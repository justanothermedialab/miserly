/**
 * Property tests for ledger.ts — the point of M1. See task brief for the
 * five invariants under test.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compareDates, parseDate } from '../src/date.js';
import { Money } from '../src/money.js';
import { balanceAsOf, orderedBalance, projectedBalance, runningBalances } from '../src/ledger.js';
import type { Transaction } from '../src/transaction.js';
import {
  BEFORE_POOL_DATE_ISO,
  CURRENCY,
  dateIsoArb,
  makeTx,
  nonEmptyTransactionsArb,
  openingArb,
  paiseArb,
  sameDateAmountsArb,
  transactionsArb,
} from './generators.js';

/**
 * Independent oracle for running balances: sorts by (date ISO string,
 * sequence) using plain comparisons (not the production comparator in
 * ordering.ts) and folds manually. Used to double-check production output
 * without simply re-running the same code under test.
 */
function oracleRunningBalances(
  opening: Money,
  txs: readonly Transaction[],
): Array<{ id: string; balance: Money }> {
  const sorted = [...txs].sort((a, b) => {
    const aIso = a.date.toString();
    const bIso = b.date.toString();
    if (aIso < bIso) return -1;
    if (aIso > bIso) return 1;
    return a.sequence - b.sequence;
  });
  let balance = opening;
  return sorted.map((tx) => {
    balance = balance.add(tx.amount);
    return { id: tx.id, balance };
  });
}

describe('ledger property: order independence (core invariant)', () => {
  it('orderedBalance is invariant under shuffling the input array', () => {
    const arb = fc
      .tuple(openingArb, transactionsArb)
      .chain(([opening, txs]) =>
        fc.tuple(
          fc.constant(opening),
          fc.constant(txs),
          fc.shuffledSubarray(txs, { minLength: txs.length, maxLength: txs.length }),
        ),
      );

    fc.assert(
      fc.property(arb, ([opening, txs, shuffled]) => {
        const direct = orderedBalance(opening, txs);
        const viaShuffled = orderedBalance(opening, shuffled);
        expect(viaShuffled.equals(direct)).toBe(true);

        // And it must equal a plain fold over the amounts, independent of order.
        const manualSum = txs.reduce((acc, tx) => acc.add(tx.amount), opening);
        expect(direct.equals(manualSum)).toBe(true);
      }),
    );
  });
});

describe('ledger property: back-dated insert', () => {
  it('orderedBalance and runningBalances re-derive correctly after inserting an earlier-dated row', () => {
    fc.assert(
      fc.property(openingArb, nonEmptyTransactionsArb, paiseArb, (opening, txs, backdatedPaise) => {
        const backdated = makeTx({
          id: 'backdated',
          dateIso: BEFORE_POOL_DATE_ISO,
          sequence: 0,
          paise: backdatedPaise,
        });
        const augmented = [...txs, backdated];

        // orderedBalance reflects the new row regardless of insertion position.
        const before = orderedBalance(opening, txs);
        const after = orderedBalance(opening, augmented);
        expect(after.equals(before.add(backdated.amount))).toBe(true);

        // The back-dated row must be first in derivation order (it is earlier
        // than every pool date), and every row's running balance must match
        // an independent (date, sequence)-sorted oracle.
        const production = runningBalances(opening, augmented).map((r) => ({
          id: r.transaction.id,
          balance: r.balance,
        }));
        const oracle = oracleRunningBalances(opening, augmented);

        expect(production.length).toBe(oracle.length);
        for (let i = 0; i < production.length; i++) {
          expect(production[i]!.id).toBe(oracle[i]!.id);
          expect(production[i]!.balance.equals(oracle[i]!.balance)).toBe(true);
        }
        expect(production[0]!.id).toBe('backdated');
        expect(production[0]!.balance.equals(opening.add(backdated.amount))).toBe(true);
      }),
    );
  });
});

describe('ledger property: same-date reorder', () => {
  it('reordering same-date rows changes intermediate balances via a correct fold, but not the final balance', () => {
    fc.assert(
      fc.property(openingArb, sameDateAmountsArb, (opening, amounts) => {
        const fixedDateIso = '2024-01-01';

        const originalTxs = amounts.map((paise, i) =>
          makeTx({ id: `orig-${i}`, dateIso: fixedDateIso, sequence: i, paise }),
        );

        // "Reorder": same date, same multiset of amounts, but a different
        // assignment of amount -> sequence slot (a permutation of amounts
        // is deterministically derived from the input by reversing it —
        // this is intentionally NOT the identity permutation whenever the
        // amounts aren't already a palindrome).
        const reversedAmounts = [...amounts].reverse();
        const reorderedTxs = reversedAmounts.map((paise, i) =>
          makeTx({ id: `reord-${i}`, dateIso: fixedDateIso, sequence: i, paise }),
        );

        const originalRows = runningBalances(opening, originalTxs);
        const reorderedRows = runningBalances(opening, reorderedTxs);

        // Final balance is order-independent (sum is commutative).
        const finalOriginal = originalRows[originalRows.length - 1]!.balance;
        const finalReordered = reorderedRows[reorderedRows.length - 1]!.balance;
        expect(finalOriginal.equals(finalReordered)).toBe(true);
        expect(finalOriginal.equals(orderedBalance(opening, originalTxs))).toBe(true);

        // Each row's running balance must match an independent prefix-sum oracle.
        let acc = opening;
        for (let i = 0; i < originalTxs.length; i++) {
          acc = acc.add(originalTxs[i]!.amount);
          expect(originalRows[i]!.balance.equals(acc)).toBe(true);
        }
        let accReordered = opening;
        for (let i = 0; i < reorderedTxs.length; i++) {
          accReordered = accReordered.add(reorderedTxs[i]!.amount);
          expect(reorderedRows[i]!.balance.equals(accReordered)).toBe(true);
        }
      }),
    );
  });
});

describe('ledger property: as-of / projected reconcile', () => {
  it('balanceAsOf(asOf) + sum(strictly-future rows) === orderedBalance === projectedBalance', () => {
    fc.assert(
      fc.property(openingArb, transactionsArb, dateIsoArb, (opening, txs, asOfIso) => {
        const asOf = parseDate(asOfIso);
        const asOfBalance = balanceAsOf(opening, txs, asOf);

        const futureSum = txs
          .filter((tx) => compareDates(tx.date, asOf) > 0)
          .reduce((acc, tx) => acc.add(tx.amount), Money.zero(CURRENCY));

        const reconciled = asOfBalance.add(futureSum);
        const projected = projectedBalance(opening, txs);
        const ordered = orderedBalance(opening, txs);

        expect(reconciled.equals(projected)).toBe(true);
        expect(projected.equals(ordered)).toBe(true);
      }),
    );
  });
});
