/**
 * import-untrusted-file.test.ts: an uploaded Actual export is a file from anyone, so nothing in it
 * decides what SQL the server runs. The sample export is edited in memory.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { makeZip } from './fixtures/make-zip';
import { readZipExactly } from '../src/lib/server/import/zip';
import { readActualExport, ActualFileError } from '../src/lib/server/import/actual-read';

const SAMPLE = path.resolve(__dirname, 'fixtures/Sample-budget-export.zip');

function changedSample(edit: (db: Database.Database) => void): Buffer {
  const raw = readZipExactly(fs.readFileSync(SAMPLE), { 'db.sqlite': 10_000_000, 'metadata.json': 65_536 }, 'x').get('db.sqlite')!;
  const db = new Database(raw);
  edit(db);
  const bytes = db.serialize();
  db.close();
  return makeZip([
    { name: 'db.sqlite', data: bytes },
    { name: 'metadata.json', data: Buffer.from('{"id":"changed","budgetName":"Changed"}') },
  ]);
}

const PLANTED_VIEW = `CREATE VIEW v_transactions AS
  SELECT 'planted' AS id, 0 AS is_parent, 0 AS is_child, NULL AS parent_id,
         (SELECT id FROM accounts WHERE tombstone = 0 ORDER BY id LIMIT 1) AS account, NULL AS category,
         123 AS amount, NULL AS payee, 'the file chose this row' AS notes, 20260101 AS date,
         0 AS starting_balance_flag, NULL AS transfer_id, 0 AS sort_order, 0 AS tombstone`;

describe('S10: the uploaded file runs none of its own SQL', () => {
  it("the file's own v_transactions view does not decide the rows read", () => {
    const sample = readActualExport(fs.readFileSync(SAMPLE));
    const planted = readActualExport(changedSample((db) => db.exec(`DROP VIEW v_transactions; ${PLANTED_VIEW}`)));
    expect(planted.rows.some((r) => r.id === 'planted')).toBe(false);
    expect(planted.rows).toHaveLength(sample.rows.length);
  });

  it('a file whose transactions table is a view (here, one that never ends) is refused', () => {
    const zip = changedSample((db) =>
      db.exec(`ALTER TABLE transactions RENAME TO real_transactions;
        CREATE VIEW transactions AS WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r)
          SELECT t.* FROM real_transactions t, r`),
    );
    expect(() => readActualExport(zip)).toThrow(ActualFileError);
  });

  it.each([20260231, 2026011, 20261301])('S23: a bank row dated %i turns the file away', (bad) => {
    const zip = changedSample((db) => {
      const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'Cash'").get() as { id: string }).id;
      db.prepare(
        'INSERT INTO transactions (id, acct, amount, date, isParent, isChild, tombstone, sort_order, starting_balance_flag) VALUES (?, ?, ?, ?, 0, 0, 0, 1, 0)',
      ).run('bad-date-1', acct, -500, bad);
    });
    expect(() => readActualExport(zip)).toThrow(ActualFileError);
    expect(() => readActualExport(zip)).toThrow("This zip isn't Actual Budget's export");
  });

  it("reads, from an untouched export, exactly the rows Actual's own view gives", () => {
    const b = readActualExport(fs.readFileSync(SAMPLE));
    expect(b.rows).toHaveLength(273);
    const raw = readZipExactly(fs.readFileSync(SAMPLE), { 'db.sqlite': 10_000_000, 'metadata.json': 65_536 }, 'x').get('db.sqlite')!;
    const db = new Database(raw, { readonly: true });
    const viaView = db
      .prepare(
        `SELECT id, account, category, amount, payee, date, transfer_id, sort_order, parent_id, is_parent
           FROM v_transactions WHERE tombstone = 0 AND is_parent = 0 AND account IS NOT NULL ORDER BY account, date, sort_order, id`,
      )
      .all() as { id: string; account: string; category: string | null; amount: number; date: number; transfer_id: string | null; sort_order: number; parent_id: string | null }[];
    db.close();
    expect(b.rows.map((r) => [r.id, r.accountId, r.categoryId, r.amount, r.date, r.transferId, r.sortOrder, r.splitId])).toEqual(
      viaView.map((v) => {
        const d = String(v.date);
        return [v.id, v.account, v.category, v.amount, `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, v.transfer_id, v.sort_order ?? 0, v.parent_id];
      }),
    );
  });
});
