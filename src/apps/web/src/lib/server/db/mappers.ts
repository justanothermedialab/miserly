/**
 * mappers.ts — SQLite row → engine domain object translation.
 * ============================================================================
 * Pure functions, no DB access. They reconstruct the DB-free domain objects the
 * `@miserly/core` engine consumes (Money integer-paise, Temporal.PlainDate) out
 * of raw Drizzle rows. The engine never sees a row shape; this is the only seam
 * that knows both.
 *
 * Single-currency INR at M3: a transaction row stores NO currency of its own —
 * an amount's currency is the OWNING ACCOUNT's currency, so it is passed in.
 * ============================================================================
 */
import { Money, parseDate } from '@miserly/core';
import type { Transaction, AccountView, CurrencyCode, PlainDate } from '@miserly/core';
import type * as schema from './schema';
import { nearestRealDate } from '../../dates';

/** Parsed dates by their stored text. A ledger has a few thousand distinct days at most, and the
 *  Temporal polyfill's parse was about half the server's time on every page: each day is
 *  parsed once per process. PlainDate is immutable, so one object serves every row. */
const parsed = new Map<string, PlainDate>();
const PARSED_MAX = 50_000;

/** A date read from the file: one that isn't a day of the calendar reads as the nearest that is
 *  (`nearestRealDate`, hosted audit H2), so one bad row can't stop every page. */
export function parseStoredDate(iso: string): PlainDate {
  let d = parsed.get(iso);
  if (d === undefined) {
    if (parsed.size >= PARSED_MAX) parsed.clear();
    d = parseDate(nearestRealDate(iso));
    parsed.set(iso, d);
  }
  return d;
}

/** The columns the engine reads of a persisted row (never `notes`), optionally with its
 *  "counts as return" flag resolved by the loader (from the row's category, or on
 *  a transfer leg its partner's; see `returnFlags`). */
export type TransactionRow = Pick<
  typeof schema.transactions.$inferSelect,
  'id' | 'accountId' | 'date' | 'sequence' | 'amountPaise' | 'categoryId' | 'payeeId' | 'transferPartnerId' | 'enteredBy' | 'kind'
> & { readonly countsAsReturn?: boolean | null };
type AccountRow = typeof schema.accounts.$inferSelect;

/**
 * Map a persisted transaction row to the engine `Transaction`. The amount's
 * currency comes from the owning account (`currency`). Optional forward-compat
 * fields are OMITTED when null/undefined so they satisfy the core type's
 * `field?: string` shape rather than being set to `null`.
 */
export function rowToTransaction(row: TransactionRow, currency: CurrencyCode): Transaction {
  const tx: {
    -readonly [K in keyof Transaction]: Transaction[K];
  } = {
    id: row.id,
    accountId: row.accountId,
    date: parseStoredDate(row.date),
    sequence: row.sequence,
    amount: Money.fromPaise(row.amountPaise, currency),
  };

  if (row.categoryId != null) tx.categoryId = row.categoryId;
  if (row.payeeId != null) tx.payeeId = row.payeeId;
  if (row.transferPartnerId != null) tx.transferPartnerId = row.transferPartnerId;
  if (row.enteredBy != null) tx.enteredBy = row.enteredBy;
  if (row.kind != null) tx.kind = row.kind;
  if (row.countsAsReturn != null) tx.countsAsReturn = row.countsAsReturn;

  return tx;
}

/**
 * Map an account row + its transaction rows to the engine `AccountView`. The
 * account's currency flows into every mapped transaction's amount.
 */
export function rowToAccountView(
  accountRow: AccountRow,
  txRows: readonly TransactionRow[],
): AccountView {
  const currency = accountRow.currency;
  return {
    id: accountRow.id,
    type: accountRow.type,
    currency,
    status: accountRow.status,
    opening: Money.fromPaise(accountRow.openingPaise, currency),
    transactions: txRows.map((r) => rowToTransaction(r, currency)),
  };
}
