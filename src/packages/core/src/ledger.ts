/**
 * ledger.ts — derived running balance.
 *
 * The single source of truth rule (architecture.md): balance is NEVER
 * stored, it is `opening + Σ(ordered transactions)`, always derived on
 * read. Every function here derives over the `(date, sequence)`-ordered
 * set — never insert order, never id order.
 */
import { compareDates } from './date.js';
import type { PlainDate } from './date.js';
import type { Money } from './money.js';
import { sortTransactions } from './ordering.js';
import type { Transaction } from './transaction.js';

/**
 * Final balance = opening + Σ(amount) over ALL transactions, computed by
 * folding over the `(date, sequence)`-ordered set. (Addition is
 * commutative, so the final sum equals opening+Σ regardless of fold order —
 * but ordering is still required conceptually: this is the same fold
 * `runningBalances` performs, just keeping only the last value.)
 */
export function orderedBalance(opening: Money, txs: readonly Transaction[]): Money {
  const ordered = sortTransactions(txs);
  let balance = opening;
  for (const tx of ordered) {
    balance = balance.add(tx.amount);
  }
  return balance;
}

export interface RunningBalanceRow {
  readonly transaction: Transaction;
  readonly balance: Money;
}

/**
 * Per-row running balance: each row's balance = opening + Σ amounts of all
 * rows up to and including it, in `(date, sequence)` order. Correct after a
 * back-dated insert (shifts every later row) and after a same-date reorder
 * (changes intermediate rows, final balance unchanged). Never uses
 * `id <= someId` — that is exactly the bug class this avoids.
 */
export function runningBalances(
  opening: Money,
  txs: readonly Transaction[],
): RunningBalanceRow[] {
  const ordered = sortTransactions(txs);
  const rows: RunningBalanceRow[] = [];
  let balance = opening;
  for (const tx of ordered) {
    balance = balance.add(tx.amount);
    rows.push({ transaction: tx, balance });
  }
  return rows;
}

/**
 * "As-of" balance (the as-of-today rule): sum only rows with
 * `date <= asOfDate`, over the ordered set.
 */
export function balanceAsOf(
  opening: Money,
  txs: readonly Transaction[],
  asOfDate: PlainDate,
): Money {
  const ordered = sortTransactions(txs);
  let balance = opening;
  for (const tx of ordered) {
    if (compareDates(tx.date, asOfDate) <= 0) {
      balance = balance.add(tx.amount);
    }
  }
  return balance;
}

/**
 * Projected balance: includes ALL rows, future-dated included.
 * `orderedBalance(opening, txs) === projectedBalance(opening, txs)` always.
 */
export function projectedBalance(opening: Money, txs: readonly Transaction[]): Money {
  return orderedBalance(opening, txs);
}
