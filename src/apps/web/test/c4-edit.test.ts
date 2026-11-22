/**
 * c4-edit.test.ts — C4 edit machinery (edit · delete · restore · duplicate ·
 * reorder · bulk), with optimistic concurrency and transfer-pair syncing.
 * ============================================================================
 * Proves: balance recompute after edit; the OPTIMISTIC check rejects a stale
 * write (mutation-5 guard); a date change re-sequences; a transfer edit SYNCS
 * the partner and stays net-worth-invariant; a category on a transfer is
 * rejected; delete/restore act on BOTH transfer legs (mutation: single-side
 * delete); duplicate + reorder; bulk is atomic and skips transfers for category;
 * a bulk delete is undoable in one step (REL-03 / C4 "single or bulk" undo).
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance, runningBalances } from '../src/lib/server/db/balances';
import { createAccount } from '../src/lib/server/accounts';
import { createTransfer } from '../src/lib/server/transfers';
import {
  createTransaction,
  updateTransaction,
  deleteTransaction,
  restoreTransaction,
  restoreTransactions,
  duplicateTransaction,
  reorderWithinDate,
  bulkUpdate,
  StaleEditError,
  TransferCategoryError,
} from '../src/lib/server/transactions';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

function seed(): Db {
  const h = createDb(':memory:');
  handle = h;
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db.insert(schema.users).values([
    { id: 'owner1', username: 'o1', displayName: 'Owner 1', role: 'admin' },
    { id: 'owner2', username: 'o2', displayName: 'Owner 2', role: 'member' },
  ]).run();
  h.db.insert(schema.categoryGroups).values({ id: 'g1', name: 'Living', kind: 'spending' }).run();
  h.db.insert(schema.categories).values([
    { id: 'c1', groupId: 'g1', name: 'Groceries' },
    { id: 'c2', groupId: 'g1', name: 'Fuel' },
  ]).run();
  return h;
}

async function acct(h: Db, owner = 'owner1', opening = 0): Promise<string> {
  const a = await createAccount(h, {
    ownerId: owner, type: 'bank', name: `A-${Math.random().toString(36).slice(2, 8)}`,
    currency: 'INR', openingPaise: opening, openingDate: opening === 0 ? null : '2024-01-01',
  });
  return a.id;
}
const U = { userId: 'owner1' };

describe('updateTransaction', () => {
  it('editing the amount recomputes the derived balance', async () => {
    const h = seed();
    const a = await acct(h, 'owner1', 1000_00);
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -100_00 });
    await updateTransaction(h, U, tx.id, { amountPaise: -250_00 }, tx.updatedAt);
    expect(accountBalance(h.sqlite, a)).toBe(750_00);
  });

  it('rejects a STALE edit (wrong expectedUpdatedAt) and leaves the row unchanged', async () => {
    const h = seed();
    const a = await acct(h, 'owner1', 1000_00);
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -100_00 });
    await expect(
      updateTransaction(h, U, tx.id, { amountPaise: -500_00 }, '1999-01-01T00:00:00.000Z'),
    ).rejects.toBeInstanceOf(StaleEditError);
    expect(accountBalance(h.sqlite, a)).toBe(900_00); // unchanged
  });

  it('a date change re-sequences and the running balance stays correct', async () => {
    const h = seed();
    const a = await acct(h, 'owner1', 0);
    const t1 = await createTransaction(h, U, { accountId: a, date: '2024-02-10', amountPaise: 100_00 });
    await createTransaction(h, U, { accountId: a, date: '2024-02-20', amountPaise: 50_00 });
    // Back-date t1 before both — window fn must re-order correctly.
    await updateTransaction(h, U, t1.id, { date: '2024-01-01' }, t1.updatedAt);
    const rows = runningBalances(h.sqlite, a);
    expect(rows.map((r) => r.id)[0]).toBe(t1.id); // now first
    expect(accountBalance(h.sqlite, a)).toBe(150_00);
  });

  it('rejects setting a category on a transfer', async () => {
    const h = seed();
    const from = await acct(h, 'owner1', 1000_00);
    const to = await acct(h, 'owner1', 0);
    const t = await createTransfer(h, U, { fromId: from, toId: to, amountPaise: 100_00, date: '2024-02-01' });
    const row = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, t.fromTxId)).get()!;
    await expect(
      updateTransaction(h, U, t.fromTxId, { categoryId: 'c1' }, row.updatedAt),
    ).rejects.toBeInstanceOf(TransferCategoryError);
  });

  it('editing a transfer amount syncs the partner and stays net-worth-invariant', async () => {
    const h = seed();
    const from = await acct(h, 'owner1', 1000_00);
    const to = await acct(h, 'owner1', 0);
    const t = await createTransfer(h, U, { fromId: from, toId: to, amountPaise: 100_00, date: '2024-02-01' });
    const fromRow = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, t.fromTxId)).get()!;
    const before = accountBalance(h.sqlite, from) + accountBalance(h.sqlite, to);
    await updateTransaction(h, U, t.fromTxId, { amountPaise: -300_00 }, fromRow.updatedAt);
    expect(accountBalance(h.sqlite, from)).toBe(700_00);
    expect(accountBalance(h.sqlite, to)).toBe(300_00); // partner mirrored to +300
    expect(accountBalance(h.sqlite, from) + accountBalance(h.sqlite, to)).toBe(before);
  });
});

describe('deleteTransaction / restoreTransaction', () => {
  it('deletes then restores an ordinary row (balance round-trips)', async () => {
    const h = seed();
    const a = await acct(h, 'owner1', 1000_00);
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -100_00 });
    const { deletedIds } = await deleteTransaction(h, U, tx.id, tx.updatedAt);
    expect(deletedIds).toEqual([tx.id]);
    expect(accountBalance(h.sqlite, a)).toBe(1000_00);
    await restoreTransaction(h, U, tx.id);
    expect(accountBalance(h.sqlite, a)).toBe(900_00);
  });

  it('deleting one side of a transfer deletes BOTH; restore brings BOTH back', async () => {
    const h = seed();
    const from = await acct(h, 'owner1', 1000_00);
    const to = await acct(h, 'owner1', 0);
    const t = await createTransfer(h, U, { fromId: from, toId: to, amountPaise: 200_00, date: '2024-02-01' });
    const fromRow = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, t.fromTxId)).get()!;
    const { deletedIds } = await deleteTransaction(h, U, t.fromTxId, fromRow.updatedAt);
    expect(new Set(deletedIds)).toEqual(new Set([t.fromTxId, t.toTxId]));
    expect(accountBalance(h.sqlite, from)).toBe(1000_00);
    expect(accountBalance(h.sqlite, to)).toBe(0);
    await restoreTransaction(h, U, t.fromTxId);
    expect(accountBalance(h.sqlite, from)).toBe(800_00);
    expect(accountBalance(h.sqlite, to)).toBe(200_00);
  });

  it('rejects a stale delete', async () => {
    const h = seed();
    const a = await acct(h, 'owner1', 1000_00);
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -100_00 });
    await expect(deleteTransaction(h, U, tx.id, 'stale')).rejects.toBeInstanceOf(StaleEditError);
    expect(accountBalance(h.sqlite, a)).toBe(900_00);
  });
});

describe('duplicateTransaction / reorderWithinDate', () => {
  it('duplicates a row onto the same date with the next sequence', async () => {
    const h = seed();
    const a = await acct(h, 'owner1', 0);
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -40_00, categoryId: 'c1' });
    const dup = await duplicateTransaction(h, U, tx.id);
    const dupRow = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, dup.id)).get()!;
    expect(dupRow.amountPaise).toBe(-40_00);
    expect(dupRow.categoryId).toBe('c1');
    expect(dupRow.sequence).toBe(1); // after the original's 0
  });

  it('reorders two same-date rows by swapping sequence', async () => {
    const h = seed();
    const a = await acct(h, 'owner1', 0);
    const t0 = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: 100_00 });
    const t1 = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: 200_00 });
    // t1 is sequence 1 (below t0 in ledger order). Move it "down" (earlier).
    await reorderWithinDate(h, U, t1.id, 'down');
    const rows = runningBalances(h.sqlite, a);
    expect(rows.map((r) => r.id)).toEqual([t1.id, t0.id]);
  });
});

describe('bulkUpdate', () => {
  it('sets a category on many rows but SKIPS transfers (counted)', async () => {
    const h = seed();
    const a = await acct(h, 'owner1', 1000_00);
    const b = await acct(h, 'owner1', 0);
    const x = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -10_00 });
    const y = await createTransaction(h, U, { accountId: a, date: '2024-02-02', amountPaise: -20_00 });
    const t = await createTransfer(h, U, { fromId: a, toId: b, amountPaise: 30_00, date: '2024-02-03' });
    const res = await bulkUpdate(h, U, [x.id, y.id, t.fromTxId], { kind: 'setCategory', categoryId: 'c2' });
    expect(res.affected).toBe(2);
    expect(res.skippedTransfers).toBe(1);
    const xr = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, x.id)).get()!;
    expect(xr.categoryId).toBe('c2');
    const tr = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, t.fromTxId)).get()!;
    expect(tr.categoryId).toBeNull(); // transfer untouched
  });

  it('only touches rows the actor can see', async () => {
    const h = seed();
    const mine = await acct(h, 'owner1', 0);
    const theirs = await acct(h, 'owner2', 0);
    const m = await createTransaction(h, U, { accountId: mine, date: '2024-02-01', amountPaise: -10_00 });
    const o = await createTransaction(h, { userId: 'owner2' }, { accountId: theirs, date: '2024-02-01', amountPaise: -10_00 });
    const res = await bulkUpdate(h, U, [m.id, o.id], { kind: 'setNotes', notes: 'batch' });
    expect(res.affected).toBe(1); // only mine
    const or = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, o.id)).get()!;
    expect(or.notes).toBeNull();
  });
});

describe('bulk delete → restoreTransactions (REL-03 undo)', () => {
  it('restores every row a bulk delete tombstoned, transfer partners included', async () => {
    const h = seed();
    const a = await acct(h, 'owner1', 1000_00);
    const b = await acct(h, 'owner1', 0);
    const x = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -10_00 });
    const y = await createTransaction(h, U, { accountId: a, date: '2024-02-02', amountPaise: -20_00 });
    const t = await createTransfer(h, U, { fromId: a, toId: b, amountPaise: 30_00, date: '2024-02-03' });

    const res = await bulkUpdate(h, U, [x.id, y.id, t.fromTxId], { kind: 'delete' });
    expect(new Set(res.deletedIds)).toEqual(new Set([x.id, y.id, t.fromTxId]));
    expect(accountBalance(h.sqlite, a)).toBe(1000_00);
    expect(accountBalance(h.sqlite, b)).toBe(0);

    const { restored } = await restoreTransactions(h, U, res.deletedIds);
    expect(restored).toBe(3);
    expect(accountBalance(h.sqlite, a)).toBe(940_00);
    expect(accountBalance(h.sqlite, b)).toBe(30_00); // the partner leg came back too
  });

  it('restores nothing when any row is on an account the actor cannot see', async () => {
    const h = seed();
    const mine = await acct(h, 'owner1', 0);
    const theirs = await acct(h, 'owner2', 0);
    const m = await createTransaction(h, U, { accountId: mine, date: '2024-02-01', amountPaise: -10_00 });
    const o = await createTransaction(h, { userId: 'owner2' }, { accountId: theirs, date: '2024-02-01', amountPaise: -10_00 });
    await bulkUpdate(h, U, [m.id], { kind: 'delete' });
    await bulkUpdate(h, { userId: 'owner2' }, [o.id], { kind: 'delete' });

    await expect(restoreTransactions(h, U, [m.id, o.id])).rejects.toThrow();
    expect(accountBalance(h.sqlite, mine)).toBe(0); // all-or-nothing: mine stays deleted
    expect(accountBalance(h.sqlite, theirs)).toBe(0);
  });
});
