/**
 * transfer-categories.test.ts: the decision on categories on transfers. A transfer between a
 * spending account (bank, card) and a holding takes a category, kept on its spending-side leg and shown on both; any
 * other transfer takes none. In reports it counts by the category's kind: Spending is spending,
 * Not in reports (Investments) is R3's Invested figure; an uncategorised transfer stays out.
 * Net worth never moves (the category is a label).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance } from '../src/lib/server/db/balances';
import { createAccount } from '../src/lib/server/accounts';
import { createTransfer } from '../src/lib/server/transfers';
import { recentActivity } from '../src/lib/server/dashboard';
import { spendingByCategory, incomeVsExpense, spendingByCategoryByMonth } from '../src/lib/server/reports';
import {
  createTransaction,
  updateTransaction,
  bulkUpdate,
  registerView,
  setTransferAccount,
  inboxTransactions,
  transferTakesCategory,
  TransferCategoryError,
  HiddenTransferError,
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
    { id: 'u1', username: 'u1', displayName: 'Alice', role: 'admin' },
    { id: 'u2', username: 'u2', displayName: 'Carol', role: 'member' },
  ]).run();
  h.db.insert(schema.categoryGroups).values([
    { id: 'g-live', name: 'Living', kind: 'spending' },
    { id: 'g-inv', name: 'Investments', kind: 'investments' }, // as migration 0012 moves the seeded group (C2 A)
    { id: 'g-inc', name: 'Income', kind: 'income' },
  ]).run();
  h.db.insert(schema.categories).values([
    { id: 'groc', groupId: 'g-live', name: 'Groceries' },
    { id: 'sip', groupId: 'g-inv', name: 'SIP' },
    { id: 'sal', groupId: 'g-inc', name: 'Salary' },
  ]).run();
  return h;
}
async function acct(h: Db, type: string, owner = 'u1'): Promise<string> {
  const a = await createAccount(h, {
    ownerId: owner, type, name: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    currency: 'INR', openingPaise: type === 'bank' ? 1_00_000_00 : 0, openingDate: '2024-01-01',
  });
  return a.id;
}
const U = { userId: 'u1' };
const row = (h: Db, id: string) => h.db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()!;
const RANGE = { from: '2024-03-01', to: '2024-03-31' };

describe('which transfers take a category', () => {
  it('a bank or card with a holding or liability, either way; never bank ↔ bank or holding ↔ holding', () => {
    expect(transferTakesCategory('bank', 'mutualFunds')).toBe(true);
    expect(transferTakesCategory('loan', 'bank')).toBe(true);
    expect(transferTakesCategory('creditCard', 'gold')).toBe(true);
    expect(transferTakesCategory('bank', 'creditCard')).toBe(false); // a card bill
    expect(transferTakesCategory('bank', 'bank')).toBe(false);
    expect(transferTakesCategory('mutualFunds', 'stocks')).toBe(false);
  });

  it('a SIP set from either register lands on the bank leg and shows on both', async () => {
    const h = seed();
    const bank = await acct(h, 'bank');
    const fund = await acct(h, 'mutualFunds');
    const t = await createTransfer(h, U, { fromId: bank, toId: fund, amountPaise: 10_000_00, date: '2024-03-10' });
    // From the fund's register (its leg holds no category; the edit goes to the bank leg).
    await updateTransaction(h, U, t.toTxId, { categoryId: 'sip' }, row(h, t.toTxId).updatedAt);
    expect(row(h, t.fromTxId).categoryId).toBe('sip');
    expect(row(h, t.toTxId).categoryId).toBeNull();
    for (const [account, id] of [[bank, t.fromTxId], [fund, t.toTxId]] as const) {
      const r = (await registerView(h, 'u1', account)).rows.find((x) => x.id === id)!;
      expect(r.categoryName).toBe('SIP');
      expect(r.takesCategory).toBe(true);
    }
    // The fund leg's memo edit re-posts the shown category: nothing changes, nothing fails.
    await updateTransaction(h, U, t.toTxId, { categoryId: 'sip', notes: 'Oct SIP' }, row(h, t.toTxId).updatedAt);
    expect(row(h, t.fromTxId).notes).toBe('Oct SIP');
    expect(row(h, t.fromTxId).categoryId).toBe('sip');
  });

  it('createTransfer keeps a category on the spending leg, rejects one on bank ↔ bank', async () => {
    const h = seed();
    const bank = await acct(h, 'bank');
    const bank2 = await acct(h, 'bank');
    const fund = await acct(h, 'mutualFunds');
    const back = await createTransfer(h, U, { fromId: fund, toId: bank, amountPaise: 5_000_00, date: '2024-03-12', categoryId: 'sip' });
    expect(row(h, back.toTxId).categoryId).toBe('sip'); // the bank leg is the inflow here
    expect(row(h, back.fromTxId).categoryId).toBeNull();
    await expect(
      createTransfer(h, U, { fromId: bank, toId: bank2, amountPaise: 100_00, date: '2024-03-12', categoryId: 'sip' }),
    ).rejects.toBeInstanceOf(TransferCategoryError);
    const t = await createTransfer(h, U, { fromId: bank, toId: bank2, amountPaise: 100_00, date: '2024-03-12' });
    await expect(updateTransaction(h, U, t.fromTxId, { categoryId: 'groc' }, row(h, t.fromTxId).updatedAt)).rejects.toBeInstanceOf(
      TransferCategoryError,
    );
    // A blank category on such a transfer (the grid posts the row) is fine.
    await updateTransaction(h, U, t.fromTxId, { categoryId: null, notes: 'move' }, row(h, t.fromTxId).updatedAt);
    expect(row(h, t.fromTxId).notes).toBe('move');
  });

  it('bulk Set category puts it on the bank leg of a SIP and skips a bank ↔ bank transfer', async () => {
    const h = seed();
    const bank = await acct(h, 'bank');
    const bank2 = await acct(h, 'bank');
    const fund = await acct(h, 'mutualFunds');
    const sip = await createTransfer(h, U, { fromId: bank, toId: fund, amountPaise: 1_000_00, date: '2024-03-10' });
    const move = await createTransfer(h, U, { fromId: bank, toId: bank2, amountPaise: 1_000_00, date: '2024-03-10' });
    const res = await bulkUpdate(h, U, [sip.toTxId, sip.fromTxId, move.fromTxId], { kind: 'setCategory', categoryId: 'sip' });
    expect(res).toMatchObject({ affected: 1, skippedTransfers: 1 });
    expect(row(h, sip.fromTxId).categoryId).toBe('sip');
    expect(row(h, move.fromTxId).categoryId).toBeNull();
  });

  it('re-pairing a SIP to another bank clears its category; an ordinary row turned into one keeps it', async () => {
    const h = seed();
    const bank = await acct(h, 'bank');
    const bank2 = await acct(h, 'bank');
    const fund = await acct(h, 'mutualFunds');
    const sip = await createTransfer(h, U, { fromId: bank, toId: fund, amountPaise: 1_000_00, date: '2024-03-10', categoryId: 'sip' });
    await setTransferAccount(h, U, sip.fromTxId, bank2, row(h, sip.fromTxId).updatedAt);
    expect(row(h, sip.fromTxId).categoryId).toBeNull();
    const tx = await createTransaction(h, U, { accountId: bank, date: '2024-03-11', amountPaise: -2_000_00, categoryId: 'sip' });
    await setTransferAccount(h, U, tx.id, fund, tx.updatedAt);
    expect(row(h, tx.id).categoryId).toBe('sip');
  });

  it("a member can't set the category of a transfer whose bank leg they can't see", async () => {
    const h = seed();
    const bank = await acct(h, 'bank'); // alice's private bank
    const plot = await acct(h, 'property');
    // u2 has held the plot since 2024 (C5 C: a share made today would hide the 2024 row from them).
    h.db.insert(schema.accountMembers).values({ accountId: plot, userId: 'u2' }).run();
    h.db.insert(schema.accountHolderPeriods).values({ accountId: plot, userId: 'u2', fromDate: '2024-01-01', toDate: null }).run();
    const t = await createTransfer(h, U, { fromId: bank, toId: plot, amountPaise: 6_00_000_00, date: '2024-03-01', categoryId: 'sip' });
    const r = (await registerView(h, 'u2', plot)).rows.find((x) => x.id === t.toTxId)!;
    expect(r.categoryName).toBeNull(); // alice's label stays hers
    expect(r.takesCategory).toBe(false);
    // The hidden-half message (P4D: "only a transfer to or from … property" read wrong here).
    await expect(updateTransaction(h, { userId: 'u2' }, t.toTxId, { categoryId: 'groc' }, row(h, t.toTxId).updatedAt)).rejects.toBeInstanceOf(
      HiddenTransferError,
    );
    expect(row(h, t.fromTxId).categoryId).toBe('sip');
  });
});

describe('reports read the category kind', () => {
  async function month(h: Db) {
    const bank = await acct(h, 'bank');
    const fund = await acct(h, 'mutualFunds');
    const loan = await acct(h, 'loan');
    await createTransaction(h, U, { accountId: bank, date: '2024-03-01', amountPaise: 80_000_00, categoryId: 'sal' });
    await createTransaction(h, U, { accountId: bank, date: '2024-03-02', amountPaise: -3_000_00, categoryId: 'groc' });
    const sip = await createTransfer(h, U, { fromId: bank, toId: fund, amountPaise: 10_000_00, date: '2024-03-05', categoryId: 'sip' });
    await createTransfer(h, U, { fromId: fund, toId: bank, amountPaise: 2_000_00, date: '2024-03-20', categoryId: 'sip' }); // a redemption
    // A loan prepayment filed as Spending counts as spending (Actual's way, if the user wants it).
    await createTransfer(h, U, { fromId: bank, toId: loan, amountPaise: 5_000_00, date: '2024-03-07', categoryId: 'groc' });
    // Uncategorised transfers stay out of every report.
    await createTransfer(h, U, { fromId: bank, toId: fund, amountPaise: 1_000_00, date: '2024-03-08' });
    return { bank, fund, sip };
  }

  it('Investments kind: out of spending and income, in R3 as Invested (net of a redemption)', async () => {
    const h = seed();
    await month(h);
    const r2 = await spendingByCategory(h, 'u1', RANGE);
    expect(r2.totalPaise).toBe(8_000_00); // groceries 3,000 + the loan prepayment as Groceries 5,000
    const cash = await incomeVsExpense(h, 'u1', RANGE);
    expect(cash.totalIncomePaise).toBe(80_000_00);
    expect(cash.totalExpensePaise).toBe(r2.totalPaise); // R2 = R3 still, by construction
    expect(cash.totalInvestedPaise).toBe(8_000_00); // 10,000 in − 2,000 back
    expect(cash.bins.find((b) => b.month === '2024-03')?.investedPaise).toBe(8_000_00);
    const byMonth = await spendingByCategoryByMonth(h, 'u1', RANGE);
    expect(JSON.stringify(byMonth)).not.toContain('SIP');
  });

  it('net worth and balances never move with a category', async () => {
    const h = seed();
    const { bank, fund, sip } = await month(h);
    const before = [accountBalance(h.sqlite, bank), accountBalance(h.sqlite, fund)];
    await updateTransaction(h, U, sip.fromTxId, { categoryId: 'groc' }, row(h, sip.fromTxId).updatedAt);
    expect([accountBalance(h.sqlite, bank), accountBalance(h.sqlite, fund)]).toEqual(before);
    expect((await spendingByCategory(h, 'u1', RANGE)).totalPaise).toBe(18_000_00); // now spending
    expect((await incomeVsExpense(h, 'u1', RANGE)).totalInvestedPaise).toBe(-2_000_00); // only the redemption is left
  });

  it('a blank SIP is not uncategorised: not in the inbox', async () => {
    const h = seed();
    await month(h);
    expect((await inboxTransactions(h, 'u1')).length).toBe(0);
  });

  it('All transactions shows the bank leg\'s category on the transfer and finds it by category', async () => {
    const h = seed();
    await month(h);
    const rows = await recentActivity(h, 'u1', 50, 'SIP');
    const sips = rows.filter((r) => r.entryType === 'transfer');
    expect(sips.length).toBe(2);
    expect(sips.every((r) => r.categoryName === 'SIP' && r.takesCategory)).toBe(true);
  });
});
