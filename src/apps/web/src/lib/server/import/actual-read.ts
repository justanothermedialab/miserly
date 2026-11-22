/**
 * actual-read.ts — reads Actual Budget's "Export data" zip (F4).
 * ============================================================================
 * The zip holds `db.sqlite` (the budget's whole database) and `metadata.json`
 * (story F4). The database is opened read-only in memory from the
 * unzipped bytes (better-sqlite3 deserialises a buffer; nothing is written to disk).
 * The file is anyone's, so none of its own SQL runs: no view, trigger or schema
 * function. The rows are read from Actual's base tables by this
 * file's own query, built as Actual's `v_transactions` view builds them (merged
 * categories and payees resolved, deleted rows left out), after a check that each
 * name read is a plain table. Nothing is sent anywhere: a
 * file the person picked, read on their own machine or server (the data hard line).
 *
 * Out comes a plain description of the budget (accounts, groups, categories,
 * payees, rows) in Actual's own ids; `actual-import.ts` maps it to Miserly.
 * ============================================================================
 */
import Database from 'better-sqlite3';
import { readZipExactly, ZipError } from './zip';
import { isRealDate } from '../../dates';

/** A file that isn't an Actual export Miserly can read; the message is the person's. */
export class ActualFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActualFileError';
  }
}

/** Size limits: Actual's own export of a large budget runs to tens of megabytes. */
export const MAX_ZIP_BYTES = 60 * 1024 * 1024;
const MAX_DB_BYTES = 250 * 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;

/** The note Actual writes on "Done reconciling" with a difference (desktop-client `reconciliation.ts`). */
const ADJUSTMENT_NOTES = new Set(['reconciliation balance adjustment']);
/** The payee Actual gives a new account's first row (loot-core `accounts/app.ts`). */
const STARTING_PAYEE = 'starting balance';

export interface ActualAccount {
  readonly id: string;
  readonly name: string;
  readonly offBudget: boolean;
  readonly closed: boolean;
}
export interface ActualGroup {
  readonly id: string;
  readonly name: string;
  readonly isIncome: boolean;
  readonly hidden: boolean;
}
export interface ActualCategory {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly hidden: boolean;
}
export interface ActualPayee {
  readonly id: string;
  readonly name: string;
}
export interface ActualRow {
  readonly id: string;
  readonly accountId: string;
  /** 'YYYY-MM-DD' (Actual stores 20261031). */
  readonly date: string;
  /** Integer cents of the budget's currency (paise for INR). */
  readonly amount: number;
  readonly payeeId: string | null;
  readonly categoryId: string | null;
  /** The parent's note and the part's, joined, for a split's part. */
  readonly notes: string | null;
  /** The other leg's row id, for a transfer. */
  readonly transferId: string | null;
  /** The account a transfer's payee names (for a transfer that comes in as a plain row). */
  readonly transferAccountId: string | null;
  /** The split this row is a part of (its parent row is not a row here). */
  readonly splitId: string | null;
  readonly sortOrder: number;
  /** Actual's "Starting Balance" row. */
  readonly starting: boolean;
  /** Actual's "Reconciliation balance adjustment" (no payee, no category, the note). */
  readonly adjustment: boolean;
}

export interface ActualBudget {
  readonly budgetId: string | null;
  readonly budgetName: string | null;
  readonly accounts: readonly ActualAccount[];
  readonly groups: readonly ActualGroup[];
  readonly categories: readonly ActualCategory[];
  readonly payees: readonly ActualPayee[];
  /** Live rows in (account, date, sort order); a split's parent is left out, its parts kept. */
  readonly rows: readonly ActualRow[];
  /** Split parents (each now its parts). */
  readonly splits: number;
  /** Rows deleted in Actual (not brought over). */
  readonly deletedRows: number;
}

/** The columns read, per table; a file without them is from a version this can't read. */
const NEEDS: Record<string, readonly string[]> = {
  accounts: ['id', 'name', 'offbudget', 'closed', 'sort_order', 'tombstone'],
  category_groups: ['id', 'name', 'is_income', 'hidden', 'sort_order', 'tombstone'],
  categories: ['id', 'name', 'cat_group', 'hidden', 'sort_order', 'tombstone'],
  payees: ['id', 'name', 'transfer_acct', 'tombstone'],
  transactions: [
    'id', 'isParent', 'isChild', 'parent_id', 'acct', 'category', 'amount', 'description', 'notes', 'date',
    'starting_balance_flag', 'transferred_id', 'sort_order', 'tombstone',
  ],
  category_mapping: ['id', 'transferId'],
  payee_mapping: ['id', 'targetId'],
};

const WHAT = "Actual Budget's export. In Actual: Settings, Export data, then open the zip it saves";

/**
 * Actual's date number (20261031) as 'YYYY-MM-DD'. A number that isn't a day of the calendar
 * (20260231, or 2026011) turns the whole file away: stored, such a date stopped every page that
 * reads its account.
 */
function isoDate(n: number): string {
  const s = String(n);
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (s.length !== 8 || !isRealDate(iso)) throw new ActualFileError(`This zip isn't ${WHAT}.`);
  return iso;
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Read Actual's export zip into a plain budget, or throw `ActualFileError` in plain words. */
export function readActualExport(zip: Buffer): ActualBudget {
  if (zip.length > MAX_ZIP_BYTES) throw new ActualFileError('This file is too large to import (over 60 MB).');
  let files: Map<string, Buffer>;
  try {
    files = readZipExactly(zip, { 'db.sqlite': MAX_DB_BYTES, 'metadata.json': MAX_META_BYTES }, WHAT);
  } catch (err) {
    if (err instanceof ZipError) throw new ActualFileError(err.message);
    throw err;
  }

  let meta: { id?: unknown; budgetName?: unknown };
  try {
    meta = JSON.parse(files.get('metadata.json')!.toString('utf8')) as typeof meta;
  } catch {
    throw new ActualFileError(`This zip isn't ${WHAT}.`);
  }

  let db: Database.Database;
  try {
    db = new Database(files.get('db.sqlite')!, { readonly: true });
    // No function named in the file's schema runs (SQLite's advice for files from strangers).
    db.pragma('trusted_schema = OFF');
    db.prepare('SELECT 1 FROM __migrations__ LIMIT 1').all();
  } catch {
    throw new ActualFileError(`This zip isn't ${WHAT}.`);
  }
  try {
    // Every name read must be a plain table: a view, a virtual table or a computed column would
    // be the file's own SQL running on the server's one thread. A missing table is left to the
    // version message below.
    for (const table of ['__migrations__', ...Object.keys(NEEDS)]) {
      const entry = db.prepare('SELECT type, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE').get(table) as
        | { type: string; sql: string | null }
        | undefined;
      if (!entry) continue;
      const computed = (db.prepare(`PRAGMA table_xinfo(${table})`).all() as { hidden: number }[]).some((c) => c.hidden !== 0);
      if (entry.type !== 'table' || /^\s*create\s+virtual/i.test(entry.sql ?? '') || computed) {
        throw new ActualFileError(`This zip isn't ${WHAT}.`);
      }
    }
    for (const [table, cols] of Object.entries(NEEDS)) {
      const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      if (!cols.every((c) => have.has(c))) {
        throw new ActualFileError(
          "This export is from a version of Actual that Miserly can't read. Open the budget in an up-to-date Actual, export it again and open that file.",
        );
      }
    }
    return readBudget(db, meta);
  } finally {
    db.close();
  }
}

function readBudget(db: Database.Database, meta: { id?: unknown; budgetName?: unknown }): ActualBudget {
  const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

  const accounts = all<{ id: string; name: string; offbudget: number; closed: number }>(
    'SELECT id, name, offbudget, closed FROM accounts WHERE tombstone = 0 ORDER BY offbudget, sort_order, id',
  ).map((a) => ({ id: a.id, name: a.name ?? '', offBudget: a.offbudget === 1, closed: a.closed === 1 }));
  const accountIds = new Set(accounts.map((a) => a.id));

  const groups = all<{ id: string; name: string; is_income: number; hidden: number }>(
    'SELECT id, name, is_income, hidden FROM category_groups WHERE tombstone = 0 ORDER BY is_income DESC, sort_order, id',
  ).map((g) => ({ id: g.id, name: g.name ?? '', isIncome: g.is_income === 1, hidden: g.hidden === 1 }));
  const groupIds = new Set(groups.map((g) => g.id));

  const categories = all<{ id: string; name: string; cat_group: string; hidden: number }>(
    'SELECT id, name, cat_group, hidden FROM categories WHERE tombstone = 0 ORDER BY sort_order, id',
  )
    .filter((c) => groupIds.has(c.cat_group))
    .map((c) => ({ id: c.id, groupId: c.cat_group, name: c.name ?? '', hidden: c.hidden === 1 }));

  const payeeRows = all<{ id: string; name: string | null; transfer_acct: string | null }>(
    'SELECT id, name, transfer_acct FROM payees WHERE tombstone = 0',
  );
  const transferAcct = new Map(payeeRows.filter((p) => p.transfer_acct).map((p) => [p.id, p.transfer_acct!]));
  const startingPayees = new Set(payeeRows.filter((p) => lower(p.name) === STARTING_PAYEE).map((p) => p.id));
  const payees = payeeRows
    .filter((p) => !p.transfer_acct && (p.name ?? '').trim() !== '' && !startingPayees.has(p.id))
    .map((p) => ({ id: p.id, name: p.name!.trim() }));

  type V = {
    id: string; is_parent: number; is_child: number; parent_id: string | null; account: string; category: string | null;
    amount: number; payee: string | null; notes: string | null; date: number; starting_balance_flag: number | null;
    transfer_id: string | null; sort_order: number | null;
  };
  // Actual's v_transactions over v_transactions_internal_alive over v_transactions_internal, as
  // one query on the base tables (the views as Actual 26's export stores them).
  const view = all<V>(
    `SELECT t.id, t.isParent AS is_parent, t.isChild AS is_child,
            CASE WHEN t.isChild = 0 THEN NULL ELSE t.parent_id END AS parent_id,
            a.id AS account, c.id AS category, IFNULL(t.amount, 0) AS amount, p.id AS payee, t.notes, t.date,
            t.starting_balance_flag, t.transferred_id AS transfer_id, t.sort_order
       FROM transactions t
       LEFT JOIN category_mapping cm ON cm.id = t.category
       LEFT JOIN payee_mapping pm ON pm.id = t.description
       LEFT JOIN transactions t2 ON (t.isChild = 1 AND t2.id = t.parent_id)
       LEFT JOIN payees p ON (p.id = pm.targetId AND p.tombstone = 0)
       LEFT JOIN categories c ON (c.id = CASE WHEN t.isParent = 1 THEN NULL ELSE cm.transferId END AND c.tombstone = 0)
       LEFT JOIN accounts a ON (a.id = t.acct AND a.tombstone = 0)
      WHERE t.date IS NOT NULL AND t.acct IS NOT NULL AND (t.isChild = 0 OR t.parent_id IS NOT NULL)
        AND IFNULL(t.tombstone, 0) = 0 AND (t.isChild = 0 OR t2.tombstone = 0)
      ORDER BY account, t.date, t.sort_order, t.id`,
  ).filter((r) => accountIds.has(r.account) && typeof r.date === 'number');

  const parents = new Map(view.filter((r) => r.is_parent === 1).map((r) => [r.id, r]));
  const rows: ActualRow[] = [];
  for (const r of view) {
    if (r.is_parent === 1) continue;
    const parent = r.is_child === 1 && r.parent_id ? parents.get(r.parent_id) : undefined;
    const notes = [parent?.notes, r.notes].map((n) => (n ?? '').trim()).filter((n) => n !== '').join(': ');
    const payee = r.payee ?? parent?.payee ?? null;
    const isTransferPayee = payee !== null && transferAcct.has(payee);
    rows.push({
      id: r.id,
      accountId: r.account,
      date: isoDate(r.date),
      amount: r.amount ?? 0,
      payeeId: payee !== null && !isTransferPayee && !startingPayees.has(payee) ? payee : null,
      categoryId: r.category,
      notes: notes === '' ? null : notes,
      transferId: r.transfer_id,
      transferAccountId: isTransferPayee ? transferAcct.get(payee!)! : null,
      splitId: parent ? parent.id : null,
      sortOrder: r.sort_order ?? 0,
      starting: r.starting_balance_flag === 1 || (payee !== null && startingPayees.has(payee)),
      adjustment: payee === null && r.category === null && !r.transfer_id && ADJUSTMENT_NOTES.has(lower(r.notes)),
    });
  }

  const deleted = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE tombstone = 1 AND isParent = 0').get() as { n: number };
  return {
    budgetId: typeof meta.id === 'string' ? meta.id : null,
    budgetName: typeof meta.budgetName === 'string' ? meta.budgetName : null,
    accounts,
    groups,
    categories,
    payees,
    rows,
    splits: parents.size,
    deletedRows: deleted.n,
  };
}
