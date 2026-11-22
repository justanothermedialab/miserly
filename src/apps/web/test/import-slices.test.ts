/**
 * import-slices.test.ts: an import doesn't stop the server. Run in one go, a
 * 10,000-row import held Node's thread for 5.8 s on a low-power server, and a page anyone asked for waited
 * 5.7 s. Now it gives the thread back as it goes (`runImport`'s slices) inside one transaction,
 * and other requests' writes wait for it (`write-gate.ts`). Here: timers and reads are served while
 * it runs, a write sent meanwhile lands after it, both imports of two at once complete, a refused
 * import leaves nothing, and the progress it reports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNull } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { seedStarterCategories } from '../src/lib/server/seed';
import type { ActualBudget, ActualRow } from '../src/lib/server/import/actual-read';
import { defaultChoices, importProgress, previewImport, runImport, ImportRefusedError } from '../src/lib/server/import/actual-import';
import { exclusiveWrite, writeHeld, writeRequest } from '../src/lib/server/write-gate';

let h: Db;
beforeEach(async () => {
  h = createDb(':memory:');
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db.insert(schema.users).values([
    { id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
    { id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' },
  ]).run();
  await seedStarterCategories(h.db);
});
afterEach(() => h.sqlite.close());

const arow = (r: Pick<ActualRow, 'id' | 'accountId' | 'date' | 'amount'> & Partial<ActualRow>): ActualRow => ({
  payeeId: null, categoryId: null, notes: null, transferId: null, transferAccountId: null,
  splitId: null, sortOrder: 0, starting: false, adjustment: false, ...r,
});
/** An export with `n` rows over two accounts and 300 payees, as an owner's after years in Actual. */
function bigBudget(n: number, tag = 'a'): ActualBudget {
  const rows: ActualRow[] = [
    arow({ id: `${tag}-o1`, accountId: `${tag}-hdfc`, date: '2020-01-01', amount: 5_00_000_00, starting: true }),
    arow({ id: `${tag}-o2`, accountId: `${tag}-sbi`, date: '2020-01-01', amount: 1_00_000_00, starting: true }),
  ];
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.UTC(2020, 0, 2) + Math.floor(i / 5) * 86_400_000).toISOString().slice(0, 10);
    rows.push(arow({ id: `${tag}-r${i}`, accountId: i % 3 ? `${tag}-hdfc` : `${tag}-sbi`, date: day, amount: -(100_00 + i), payeeId: `${tag}-p${i % 300}`, notes: i % 7 ? null : 'note' }));
  }
  return {
    budgetId: `budget-${tag}`, budgetName: 'Big', groups: [], categories: [], splits: 0, deletedRows: 0,
    accounts: [
      { id: `${tag}-hdfc`, name: `HDFC ${tag}`, offBudget: false, closed: false },
      { id: `${tag}-sbi`, name: `SBI ${tag}`, offBudget: false, closed: false },
    ],
    payees: Array.from({ length: 300 }, (_, i) => ({ id: `${tag}-p${i}`, name: `Shop ${tag} ${i}` })),
    rows,
  };
}
const txCount = () => (h.sqlite.prepare('SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL').get() as { n: number }).n;
const importAll = (user: string, b: ActualBudget) => runImport(h, user, b, 'big.zip', defaultChoices(previewImport(h, user, b)));

describe('an import gives the thread back', { timeout: 30_000 }, () => {
  it('timers and reads are served while it runs; a write sent meanwhile lands after it', async () => {
    const b = bigBudget(2500);
    const ticks: number[] = [];
    const seen: number[] = [];
    let running = true;
    const timer = setInterval(() => {
      if (!running) return;
      ticks.push(performance.now());
      // A read meanwhile sees the database answer (here, the rows written so far).
      seen.push(txCount());
    }, 5);
    let atWrite: { rows: number; open: boolean } | null = null;
    const run = writeRequest(() => exclusiveWrite(() => importAll('alice', b)));
    // Another member's save, sent while the import runs: it waits, then writes after it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writeHeld()).toBe(true);
    const save = writeRequest(async () => {
      atWrite = { rows: txCount(), open: h.sqlite.inTransaction };
      h.sqlite.prepare("UPDATE users SET display_name = 'Bobby' WHERE id = 'bob'").run();
    });
    const result = await run;
    await save;
    running = false;
    clearInterval(timer);
    expect(result.transactions).toBe(2500);
    expect(txCount()).toBe(2500);
    // The thread came back while it ran (it was one block before): a timer fired and a read saw part
    // of the rows. No count of ticks: a fast machine finishes in a few of them.
    expect(ticks.length).toBeGreaterThan(0);
    expect(seen.some((n) => n > 0 && n < 2500)).toBe(true);
    // The save waited: by then the import had committed, whole.
    expect(atWrite).toEqual({ rows: 2500, open: false });
    expect(writeHeld()).toBe(false);
    expect(importProgress('alice')).toBeNull();
  });

  it('two imports at once run one after the other, both whole', async () => {
    const [a, b] = await Promise.all([
      writeRequest(() => exclusiveWrite(() => importAll('alice', bigBudget(600, 'a')))),
      writeRequest(() => exclusiveWrite(() => importAll('bob', bigBudget(600, 'b')))),
    ]);
    expect([a.transactions, b.transactions]).toEqual([600, 600]);
    expect(txCount()).toBe(1200);
  });

  it('reports its progress while it runs', async () => {
    const b = bigBudget(2500);
    const seen: { done: number; total: number }[] = [];
    const timer = setInterval(() => {
      const p = importProgress('alice');
      if (p) seen.push(p);
    }, 5);
    await exclusiveWrite(() => importAll('alice', b));
    clearInterval(timer);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.total === 2500 && p.done <= 2500)).toBe(true);
    expect(importProgress('alice')).toBeNull();
  });

  it('a refused import leaves nothing and closes its transaction', async () => {
    const b = bigBudget(50);
    const choices = defaultChoices(previewImport(h, 'alice', b));
    const bad = { ...choices, accounts: { ...choices.accounts, 'a-hdfc': { ...choices.accounts['a-hdfc']!, name: ' ' } } };
    await expect(runImport(h, 'alice', b, 'big.zip', bad)).rejects.toThrow(ImportRefusedError);
    expect(h.sqlite.inTransaction).toBe(false);
    expect(txCount()).toBe(0);
    expect(h.db.select().from(schema.accounts).where(isNull(schema.accounts.deletedAt)).all()).toHaveLength(0);
  });
});
