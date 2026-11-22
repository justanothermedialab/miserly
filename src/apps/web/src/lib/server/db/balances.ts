/**
 * balances.ts — the running-balance window function (the crown-jewel SQL).
 * ============================================================================
 * This is the highest-risk code in the persistence layer: the (date, sequence)
 * partitioning has to be right. It is the SQL twin of
 * the engine's derived-on-read ledger (packages/core/src/ledger.ts) and MUST
 * reconcile with it BIT-FOR-BIT — the M3 differential test proves it does. If
 * this drifts from the engine, it reintroduces exactly the bug class the whole
 * model exists to kill (an earlier prototype's `id<=up_to_id`; Actual Budget #3928 same-date).
 *
 * Raw SQL on the better-sqlite3 connection (the "raw-SQL escape hatch" of D9),
 * NOT the ORM — the window frame is the whole point and must be explicit.
 *
 * THREE correctness invariants, each of which the adversarial mutation test
 * must be able to break:
 *   1. ORDER BY date ASC, sequence ASC — NEVER rowid / id / insert order. This
 *      is why balance is correct under a back-dated insert and a same-date
 *      reorder. (`date` is TEXT 'YYYY-MM-DD', so lexicographic == chronological.)
 *   2. Frame = ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW — ROWS, not the
 *      SQL default RANGE. With the unique (account_id, date, sequence) key the
 *      two coincide, but ROWS is the exact row-by-row fold the engine performs
 *      and is robust if a duplicate key ever slipped in.
 *   3. deleted_at IS NULL — soft-deleted rows never contribute (M3 has no
 *      delete behaviour, but the ledger math must already honour the tombstone).
 *
 * Single-currency INR at M3: no to_base / FX (M9). Every amount here is paise.
 * ============================================================================
 */
import type { Database } from 'better-sqlite3';

/** One row of the derived running balance, in (date, sequence) ledger order. */
export interface RunningBalanceRow {
  readonly id: string;
  readonly date: string;
  readonly sequence: number;
  /** opening_paise + Σ amounts up to and including this row, in ledger order. */
  readonly balancePaise: number;
}

/**
 * Per-row running balance for one account, in (date, sequence) order — the SQL
 * equivalent of `runningBalances(opening, txs)` in the engine. Returns [] for
 * an account with no live transactions.
 */
export function runningBalances(db: Database, accountId: string): RunningBalanceRow[] {
  const rows = db
    .prepare(
      `SELECT
         t.id            AS id,
         t.date          AS date,
         t.sequence      AS sequence,
         a.opening_paise + SUM(t.amount_paise) OVER (
           PARTITION BY t.account_id
           ORDER BY t.date ASC, t.sequence ASC
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         )               AS balancePaise
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.account_id = @accountId
         AND t.deleted_at IS NULL
       ORDER BY t.date ASC, t.sequence ASC`,
    )
    .all({ accountId }) as RunningBalanceRow[];
  return rows;
}

/**
 * Scalar balance for one account — the SQL equivalent of the engine's
 * `balanceAsOf(opening, txs, asOf)` (when `asOf` is given) and of
 * `orderedBalance` / `projectedBalance` (when omitted, all live rows count,
 * future-dated included). Always includes the opening balance even when the
 * account has no transactions. Throws if the account does not exist.
 */
export function accountBalance(db: Database, accountId: string, asOf?: string): number {
  const row = db
    .prepare(
      `SELECT
         a.opening_paise
         + COALESCE((
             SELECT SUM(t.amount_paise)
             FROM transactions t
             WHERE t.account_id = a.id
               AND t.deleted_at IS NULL
               AND (@asOf IS NULL OR t.date <= @asOf)
           ), 0) AS balancePaise
       FROM accounts a
       WHERE a.id = @accountId`,
    )
    .get({ accountId, asOf: asOf ?? null }) as { balancePaise: number } | undefined;

  if (row === undefined) {
    throw new Error(`accountBalance: no account with id ${accountId}`);
  }
  return row.balancePaise;
}
