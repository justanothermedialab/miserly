/**
 * ordering.ts — the `(date, sequence)` total order.
 *
 * This is the fix for the class of bug where running balance is derived
 * from insert order / row id (see an earlier prototype's `id<=up_to_id` fragility, and
 * Actual Budget issue #3928 for the same-date variant). Ordering here is
 * ALWAYS by `(date, sequence)`, NEVER by id or array position.
 */
import { compareDates } from './date.js';
import type { Transaction } from './transaction.js';

/**
 * Total-order comparator: compare by `date` first, then by `sequence` as
 * the within-date tiebreaker. Stable (never returns 0 for distinct
 * `(date, sequence)` pairs; ties only occur for genuinely equal rows).
 */
export function compareTransactions(a: Transaction, b: Transaction): -1 | 0 | 1 {
  const dateCmp = compareDates(a.date, b.date);
  if (dateCmp !== 0) return dateCmp;
  if (a.sequence < b.sequence) return -1;
  if (a.sequence > b.sequence) return 1;
  return 0;
}

/**
 * Returns a NEW array containing `txs` sorted by `(date, sequence)`.
 * Does not mutate the input. Stable with respect to equal `(date, sequence)`
 * pairs (preserves their relative input order, per `Array.prototype.sort`'s
 * stability guarantee).
 */
export function sortTransactions(txs: readonly Transaction[]): Transaction[] {
  return [...txs].sort(compareTransactions);
}

/**
 * Given the existing transactions already on a given date, produce the
 * next monotonic `sequence` for a new transaction being inserted on that
 * same date. Pure — never inspects or assigns an id.
 *
 * Callers are expected to pre-filter `existingOnDate` to the target date;
 * this helper does not filter by date itself, so it can also be used to
 * compute "next sequence" over an arbitrary already-scoped set.
 */
export function nextSequence(existingOnDate: readonly Transaction[]): number {
  let max = -1;
  for (const tx of existingOnDate) {
    if (tx.sequence > max) max = tx.sequence;
  }
  return max + 1;
}
