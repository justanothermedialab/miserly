/**
 * hunt-2-5.test.ts: server fixes from a bug hunt.
 * An in-place edit of one field on a row whose category or payee was hidden later still saves
 * and leaves them as they were; a payee set in place joins the payee list; a closed account's
 * rows (and a transfer's leg in one) don't change; Duplicate on a transfer makes a pair; a
 * transfer's payee cell re-pairs it, makes it ordinary, or makes an ordinary row a transfer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance } from '../src/lib/server/db/balances';
import { createAccount } from '../src/lib/server/accounts';
import { createTransfer } from '../src/lib/server/transfers';
import { listPayeesFor, isPayeeVisibleTo, setRememberedCategory, rememberedCategoryFor, renamePayeeFor, deletePayeeFor } from '../src/lib/server/payees';
import { postValuationMark, editMarkTarget } from '../src/lib/server/marks';
import { transactionCreateSchema, rupeesToPaise } from '../src/lib/server/validation';
import * as v from 'valibot';
import {
  createTransaction,
  updateTransaction,
  deleteTransaction,
  duplicateTransaction,
  setTransferAccount,
  transferToPayee,
  ClosedAccountError,
  TransferEditError,
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
    { id: 'u1', username: 'u1', displayName: 'U1', role: 'admin' },
    { id: 'u2', username: 'u2', displayName: 'U2', role: 'member' },
  ]).run();
  h.db.insert(schema.categoryGroups).values({ id: 'g1', name: 'Living', kind: 'spending' }).run();
  h.db.insert(schema.categories).values([
    { id: 'c1', groupId: 'g1', name: 'Groceries' },
    { id: 'c2', groupId: 'g1', name: 'Fuel' },
  ]).run();
  return h;
}
async function acct(h: Db, owner = 'u1', currency = 'INR'): Promise<string> {
  const a = await createAccount(h, {
    ownerId: owner, type: 'bank', name: `A-${Math.random().toString(36).slice(2, 8)}`,
    currency, openingPaise: 1000_00, openingDate: '2024-01-01',
  });
  return a.id;
}
const U = { userId: 'u1' };
const row = (h: Db, id: string) => h.db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()!;
const live = (h: Db, accountId: string) =>
  h.db.select().from(schema.transactions).where(and(eq(schema.transactions.accountId, accountId), isNull(schema.transactions.deletedAt))).all();
const close = (h: Db, id: string) => h.db.update(schema.accounts).set({ status: 'closed' }).where(eq(schema.accounts.id, id)).run();

describe('one-field edits keep what they did not touch', () => {
  it('a row whose category was hidden later still takes a memo edit (the grid re-posts it)', async () => {
    const h = seed();
    const a = await acct(h);
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -100_00, categoryId: 'c2' });
    h.db.update(schema.categories).set({ hidden: true }).where(eq(schema.categories.id, 'c2')).run();
    await updateTransaction(h, U, tx.id, { categoryId: 'c2', notes: 'petrol' }, tx.updatedAt);
    expect(row(h, tx.id).notes).toBe('petrol');
    expect(row(h, tx.id).categoryId).toBe('c2');
  });

  it('a payee set in place joins the payee list and remembers the row\'s category', async () => {
    const h = seed();
    const a = await acct(h);
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -100_00, categoryId: 'c1' });
    await updateTransaction(h, U, tx.id, { payeeName: 'Corner Store' }, tx.updatedAt);
    const list = await listPayeesFor(h.db, 'u1');
    expect(list.map((p) => p.displayName)).toContain('Corner Store');
    const up = h.db.select().from(schema.userPayee).where(eq(schema.userPayee.userId, 'u1')).get();
    expect(up?.lastCategoryId).toBe('c1');
  });
});

describe('closed accounts', () => {
  it('an edit or delete of a transfer whose other leg is in a closed account is refused', async () => {
    const h = seed();
    const a = await acct(h);
    const b = await acct(h);
    const t = await createTransfer(h, U, { fromId: a, toId: b, amountPaise: 50_00, date: '2024-02-01' });
    close(h, b);
    const r = row(h, t.fromTxId);
    await expect(updateTransaction(h, U, r.id, { amountPaise: -70_00 }, r.updatedAt)).rejects.toBeInstanceOf(ClosedAccountError);
    await expect(deleteTransaction(h, U, r.id, r.updatedAt)).rejects.toBeInstanceOf(ClosedAccountError);
    expect(accountBalance(h.sqlite, b)).toBe(1050_00);
  });
});

describe('transfers from the row menu and the payee cell', () => {
  it('Duplicate on a transfer makes a second linked pair', async () => {
    const h = seed();
    const a = await acct(h);
    const b = await acct(h);
    const t = await createTransfer(h, U, { fromId: a, toId: b, amountPaise: 50_00, date: '2024-02-01' });
    const d = await duplicateTransaction(h, U, t.fromTxId);
    const dup = row(h, d.id);
    expect(dup.transferPartnerId).not.toBeNull();
    expect(row(h, dup.transferPartnerId!).accountId).toBe(b);
    expect(accountBalance(h.sqlite, a)).toBe(900_00);
    expect(accountBalance(h.sqlite, b)).toBe(1100_00);
  });

  it('picking another account moves the other leg there', async () => {
    const h = seed();
    const [a, b, c] = [await acct(h), await acct(h), await acct(h)];
    const t = await createTransfer(h, U, { fromId: a, toId: b, amountPaise: 50_00, date: '2024-02-01' });
    await setTransferAccount(h, U, t.fromTxId, c, row(h, t.fromTxId).updatedAt);
    expect(row(h, t.toTxId).accountId).toBe(c);
    expect(accountBalance(h.sqlite, b)).toBe(1000_00);
    expect(accountBalance(h.sqlite, c)).toBe(1050_00);
  });

  it('picking an account on an ordinary row makes it a transfer; a payee on a transfer makes it ordinary', async () => {
    const h = seed();
    const [a, b] = [await acct(h), await acct(h)];
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -30_00, payeeName: 'Shop', categoryId: 'c1' });
    await setTransferAccount(h, U, tx.id, b, tx.updatedAt);
    const r = row(h, tx.id);
    expect(r.categoryId).toBeNull();
    expect(row(h, r.transferPartnerId!).amountPaise).toBe(30_00);
    expect(accountBalance(h.sqlite, b)).toBe(1030_00);

    await transferToPayee(h, U, tx.id, 'Shop', r.updatedAt);
    expect(row(h, tx.id).transferPartnerId).toBeNull();
    expect(live(h, b)).toHaveLength(0);
    expect(accountBalance(h.sqlite, b)).toBe(1000_00);
    expect(accountBalance(h.sqlite, a)).toBe(970_00);
  });

  it('refuses a currency change and a leg the editor can\'t see', async () => {
    const h = seed();
    const [a, b] = [await acct(h), await acct(h)];
    const usd = await acct(h, 'u1', 'USD');
    const t = await createTransfer(h, U, { fromId: a, toId: b, amountPaise: 50_00, date: '2024-02-01' });
    await expect(setTransferAccount(h, U, t.fromTxId, usd, row(h, t.fromTxId).updatedAt)).rejects.toBeInstanceOf(TransferEditError);
    // u2 shares a; b stays u1's private account
    h.db.insert(schema.accountMembers).values({ accountId: a, userId: 'u2' }).run();
    await expect(transferToPayee(h, { userId: 'u2' }, t.fromTxId, 'Shop', row(h, t.fromTxId).updatedAt)).rejects.toBeInstanceOf(TransferEditError);
    expect(live(h, b)).toHaveLength(1);
  });
});

describe('Payees: visibility and the default category', () => {
  it('a payee used only on another member\'s private account is not visible to them', async () => {
    const h = seed();
    const mine = await acct(h, 'u1');
    const theirs = await acct(h, 'u2');
    await createTransaction(h, { userId: 'u2' }, { accountId: theirs, date: '2024-02-01', amountPaise: -10_00, payeeName: 'Dr Private' });
    await createTransaction(h, U, { accountId: mine, date: '2024-02-01', amountPaise: -10_00, payeeName: 'Mine' });
    const p = h.db.select().from(schema.payees).where(eq(schema.payees.displayName, 'Dr Private')).get()!;
    expect(await isPayeeVisibleTo(h.db, 'u1', p.id)).toBe(false);
    expect(await isPayeeVisibleTo(h.db, 'u2', p.id)).toBe(true);
  });

  it('the default category is set and cleared for this viewer only', async () => {
    const h = seed();
    const a = await acct(h);
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -10_00, payeeName: 'Shop' });
    const payeeId = row(h, tx.id).payeeId!;
    await setRememberedCategory(h.db, 'u1', payeeId, 'c2');
    expect(await rememberedCategoryFor(h.db, 'u1', payeeId)).toBe('c2');
    expect(await rememberedCategoryFor(h.db, 'u2', payeeId)).toBeNull();
    await setRememberedCategory(h.db, 'u1', payeeId, null);
    expect(await rememberedCategoryFor(h.db, 'u1', payeeId)).toBeNull();
  });
});

describe('value updates edit their date and memo', () => {
  it('moves a mark to another date and sets its memo; the gap re-derives', async () => {
    const h = seed();
    const mf = (await createAccount(h, { ownerId: 'u1', type: 'mutualFunds', name: 'Fund', currency: 'INR', openingPaise: 0, openingDate: null })).id;
    const bank = await acct(h);
    await createTransfer(h, U, { fromId: bank, toId: mf, amountPaise: 100_00, date: '2024-02-01' });
    await createTransfer(h, U, { fromId: bank, toId: mf, amountPaise: 100_00, date: '2024-04-01' });
    const m = await postValuationMark(h, U, { accountId: mf, targetPaise: 250_00, date: '2024-05-01' });
    const before = row(h, m.id!);
    expect(before.amountPaise).toBe(50_00);
    await editMarkTarget(h, U, m.id!, 250_00, before.updatedAt, { date: '2024-03-01', notes: 'statement' });
    const after = row(h, m.id!);
    expect(after.date).toBe('2024-03-01');
    expect(after.notes).toBe('statement');
    expect(after.amountPaise).toBe(150_00); // 250 target against the 100 in before 1 Mar
  });
});

describe('amounts typed with grouping', () => {
  it('1,200 and 1,20,000 parse as amounts', () => {
    const ok = v.safeParse(transactionCreateSchema, { date: '2024-02-01', outflow: '1,20,000', inflow: '', payee: '', category: '', notes: '' });
    expect(ok.success && ok.output.amountPaise).toBe(-120_000_00);
    const r = v.safeParse(rupeesToPaise, '₹1,200.50');
    expect(r.success && r.output).toBe(1200_50);
  });
});

describe('payee actions change only the rows the actor can see (P4 hunt)', () => {
  const pname = (h: Db, txId: string) => {
    const r = row(h, txId);
    return r.payeeId ? h.db.select().from(schema.payees).where(eq(schema.payees.id, r.payeeId)).get()!.displayName : null;
  };
  it('a rename by one member leaves the other member\'s private rows on the old name', async () => {
    const h = seed();
    const a1 = await acct(h, 'u1');
    const a2 = await acct(h, 'u2');
    const t1 = await createTransaction(h, U, { accountId: a1, date: '2024-02-01', amountPaise: -10_00, payeeName: 'Netflix' });
    const t2 = await createTransaction(h, { userId: 'u2' }, { accountId: a2, date: '2024-02-01', amountPaise: -10_00, payeeName: 'Netflix' });
    const id = row(h, t2.id).payeeId!;
    await renamePayeeFor(h.db, 'u2', id, 'Streaming');
    expect(pname(h, t1.id)).toBe('Netflix');
    expect(pname(h, t2.id)).toBe('Streaming');
  });

  it('a rename to a name only another member uses answers as any rename and leaves their rows', async () => {
    const h = seed();
    const a1 = await acct(h, 'u1');
    const a2 = await acct(h, 'u2');
    const t1 = await createTransaction(h, U, { accountId: a1, date: '2024-02-01', amountPaise: -10_00, payeeName: 'Amma' });
    const t2 = await createTransaction(h, { userId: 'u2' }, { accountId: a2, date: '2024-02-01', amountPaise: -10_00, payeeName: 'Truffles' });
    await expect(renamePayeeFor(h.db, 'u2', row(h, t2.id).payeeId!, 'Amma')).resolves.toBeUndefined();
    expect(pname(h, t2.id)).toBe('Amma');
    expect(pname(h, t1.id)).toBe('Amma');
    // a delete by u2 now clears only u2's row
    await deletePayeeFor(h.db, 'u2', row(h, t2.id).payeeId!);
    expect(row(h, t2.id).payeeId).toBeNull();
    expect(pname(h, t1.id)).toBe('Amma');
  });
});
