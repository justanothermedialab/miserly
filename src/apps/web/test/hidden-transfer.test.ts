/**
 * hidden-transfer.test.ts: the half of a transfer a member can't see.
 * A member can't change the half of a transfer they can't see: on a shared plot whose purchase
 * came from alice's private bank, carol's memo edits her leg only; amount, date, delete, duplicate
 * and bulk delete are refused, and alice's private row never moves. Alice, who sees both, still
 * edits the pair as one.
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
import { postValuationMark } from '../src/lib/server/marks';
import {
  registerView,
  updateTransaction,
  deleteTransaction,
  duplicateTransaction,
  bulkUpdate,
  restoreTransaction,
  restoreTransactions,
  AccountNotFoundError,
  HiddenTransferError,
} from '../src/lib/server/transactions';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

async function plot() {
  const h = createDb(':memory:');
  handle = h;
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db.insert(schema.users).values([
    { id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
    { id: 'carol', username: 'carol', displayName: 'Carol', role: 'member' },
  ]).run();
  const mk = async (type: string, opening: number) =>
    (await createAccount(h, { ownerId: 'alice', type, name: type, currency: 'INR', openingPaise: opening, openingDate: '2023-01-01' })).id;
  const sbi = await mk('bank', 10_00_000_00);
  const land = await mk('property', 0);
  // Carol has held the plot since before it was bought (a stretch from 2023, C5 C: a member sees
  // the dates they held it, so a share made today would hide the 2023 purchase from her).
  h.db.insert(schema.accountMembers).values({ accountId: land, userId: 'carol' }).run();
  h.db.insert(schema.accountHolderPeriods).values({ accountId: land, userId: 'carol', fromDate: '2023-01-01', toDate: null }).run();
  const t = await createTransfer(h, { userId: 'alice' }, { fromId: sbi, toId: land, amountPaise: 6_00_000_00, date: '2023-08-18', notes: 'Plot, Alice half' });
  return { h, sbi, land, t };
}
const C = { userId: 'carol' };
const row = (h: Db, id: string) => h.db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()!;

describe("carol can't change alice's half", () => {
  it('a memo edit changes carol\'s leg only; an unchanged amount re-posted by the grid is fine', async () => {
    const { h, t } = await plot();
    const leg = row(h, t.toTxId);
    await updateTransaction(h, C, t.toTxId, { amountPaise: leg.amountPaise, date: leg.date, notes: 'Plot, Alice half (carol)' }, leg.updatedAt);
    expect(row(h, t.toTxId).notes).toBe('Plot, Alice half (carol)');
    expect(row(h, t.fromTxId).notes).toBe('Plot, Alice half');
  });

  it('amount and date are refused with who to ask; alice\'s private balance never moves', async () => {
    const { h, sbi, t } = await plot();
    const before = accountBalance(h.sqlite, sbi);
    const leg = row(h, t.toTxId);
    const amount = updateTransaction(h, C, t.toTxId, { amountPaise: 6_10_000_00 }, leg.updatedAt);
    await expect(amount).rejects.toBeInstanceOf(HiddenTransferError);
    await expect(amount).rejects.toThrow("The other half of this transfer is in an account you can't see. Ask Alice to change it.");
    await expect(updateTransaction(h, C, t.toTxId, { date: '2023-08-19' }, leg.updatedAt)).rejects.toBeInstanceOf(HiddenTransferError);
    expect(accountBalance(h.sqlite, sbi)).toBe(before);
    expect(row(h, t.toTxId).amountPaise).toBe(6_00_000_00);
  });

  it('delete, duplicate and bulk delete leave both halves', async () => {
    const { h, t } = await plot();
    await expect(deleteTransaction(h, C, t.toTxId, row(h, t.toTxId).updatedAt)).rejects.toBeInstanceOf(HiddenTransferError);
    await expect(duplicateTransaction(h, C, t.toTxId)).rejects.toBeInstanceOf(HiddenTransferError);
    expect(await bulkUpdate(h, C, [t.toTxId], { kind: 'delete' })).toMatchObject({ affected: 0, skippedHidden: 1, deletedIds: [] });
    expect(row(h, t.fromTxId).deletedAt).toBeNull();
    expect(row(h, t.toTxId).deletedAt).toBeNull();
  });

  it('carol\'s page never gets alice\'s row id; alice still edits the pair as one', async () => {
    const { h, land, sbi, t } = await plot();
    const r = (await registerView(h, 'carol', land)).rows.find((x) => x.id === t.toTxId)!;
    expect(r.transferPartnerId).toBe('hidden');
    expect(JSON.stringify(await registerView(h, 'carol', land))).not.toContain(t.fromTxId);
    await updateTransaction(h, { userId: 'alice' }, t.toTxId, { amountPaise: 6_10_000_00 }, row(h, t.toTxId).updatedAt);
    expect(row(h, t.fromTxId).amountPaise).toBe(-6_10_000_00);
    expect(accountBalance(h.sqlite, sbi)).toBe(10_00_000_00 - 6_10_000_00);
  });

  it("carol can't bring back alice's deleted pair, alone or in a batch", async () => {
    const { h, sbi, t } = await plot();
    await deleteTransaction(h, { userId: 'alice' }, t.fromTxId, row(h, t.fromTxId).updatedAt);
    await expect(restoreTransaction(h, C, t.toTxId)).rejects.toBeInstanceOf(AccountNotFoundError);
    await expect(restoreTransactions(h, C, [t.toTxId])).rejects.toBeInstanceOf(AccountNotFoundError);
    expect(row(h, t.fromTxId).deletedAt).not.toBeNull();
    expect(accountBalance(h.sqlite, sbi)).toBe(10_00_000_00);
    await restoreTransaction(h, { userId: 'alice' }, t.toTxId); // alice sees both: her undo works
    expect(row(h, t.fromTxId).deletedAt).toBeNull();
  });

  it("a restore of a live row changes nothing; alice's own-leg edit doesn't stamp carol's row", async () => {
    const { h, t } = await plot();
    const stamp = row(h, t.fromTxId).updatedAt;
    await restoreTransaction(h, C, t.toTxId);
    expect(row(h, t.fromTxId).updatedAt).toBe(stamp);
    h.db.insert(schema.categoryGroups).values({ id: 'g', name: 'Inv', kind: 'neutral' }).run();
    h.db.insert(schema.categories).values([{ id: 'land', groupId: 'g', name: 'Land' }, { id: 'gold', groupId: 'g', name: 'Gold' }]).run();
    const plotStamp = row(h, t.toTxId).updatedAt;
    await updateTransaction(h, { userId: 'alice' }, t.fromTxId, { categoryId: 'land' }, stamp);
    expect(row(h, t.fromTxId).categoryId).toBe('land');
    expect(row(h, t.toTxId).updatedAt).toBe(plotStamp);
    // A category on alice's half, crafted by carol, gets the hidden-half message.
    await expect(updateTransaction(h, C, t.toTxId, { categoryId: 'gold' }, plotStamp)).rejects.toBeInstanceOf(HiddenTransferError);
  });
});

describe('S16 (security read): the rate of a transfer whose other half is hidden', () => {
  it("carol's row from alice's private USD account carries no rate; alice's own view keeps it", async () => {
    const { h, land } = await plot();
    const usd = (await createAccount(h, { ownerId: 'alice', type: 'bank', name: 'US bank', currency: 'USD', openingPaise: 5_000_00, openingDate: '2023-01-01' })).id;
    const t = await createTransfer(h, { userId: 'alice' }, { fromId: usd, toId: land, amountPaise: 1_000_00, date: '2023-09-01', toAmountPaise: 84_510_00 });
    const carols = (await registerView(h, 'carol', land)).rows.find((x) => x.id === t.toTxId)!;
    expect(carols.transferPartnerId).toBe('hidden');
    expect(carols.fxRateScaled).toBeNull();
    expect(carols.fxScale).toBeNull();
    const alices = (await registerView(h, 'alice', land)).rows.find((x) => x.id === t.toTxId)!;
    expect(alices.fxRateScaled).not.toBeNull();
  });
});

describe('S19, L12: bulk "set category" on a row it must not reach', () => {
  async function jointToPrivateFund() {
    const { h } = await plot();
    const mk = async (type: string, name: string) =>
      (await createAccount(h, { ownerId: 'alice', type, name, currency: 'INR', openingPaise: 1_00_000_00, openingDate: '2023-01-01' })).id;
    const joint = await mk('bank', 'Joint bank');
    const fund = await mk('mutualFunds', 'Alice fund');
    h.db.insert(schema.accountMembers).values({ accountId: joint, userId: 'carol' }).run();
    h.db.insert(schema.accountHolderPeriods).values({ accountId: joint, userId: 'carol', fromDate: '2023-01-01', toDate: null }).run();
    const t = await createTransfer(h, { userId: 'alice' }, { fromId: joint, toId: fund, amountPaise: 50_000_00, date: '2024-01-10' });
    h.db.insert(schema.categoryGroups).values({ id: 'gi', name: 'Investing', kind: 'investments' }).run();
    h.db.insert(schema.categories).values({ id: 'sip', groupId: 'gi', name: 'SIP' }).run();
    return { h, joint, fund, t };
  }

  it("a transfer whose other half carol can't see is skipped, whatever that account's type", async () => {
    const { h, t } = await jointToPrivateFund();
    const r = await bulkUpdate(h, C, [t.fromTxId], { kind: 'setCategory', categoryId: 'sip' });
    expect(r).toMatchObject({ affected: 0, skippedTransfers: 1 });
  });

  it('the same answer when the hidden account is another bank (no bit about its type)', async () => {
    const { h, sbi } = await plot();
    h.db.insert(schema.categoryGroups).values({ id: 'gi', name: 'Investing', kind: 'investments' }).run();
    h.db.insert(schema.categories).values({ id: 'sip', groupId: 'gi', name: 'SIP' }).run();
    const joint = (await createAccount(h, { ownerId: 'alice', type: 'bank', name: 'Joint 2', currency: 'INR', openingPaise: 1_00_000_00, openingDate: '2023-01-01' })).id;
    h.db.insert(schema.accountMembers).values({ accountId: joint, userId: 'carol' }).run();
    h.db.insert(schema.accountHolderPeriods).values({ accountId: joint, userId: 'carol', fromDate: '2023-01-01', toDate: null }).run();
    const t = await createTransfer(h, { userId: 'alice' }, { fromId: joint, toId: sbi, amountPaise: 10_000_00, date: '2024-01-10' });
    expect(await bulkUpdate(h, C, [t.fromTxId], { kind: 'setCategory', categoryId: 'sip' })).toMatchObject({ affected: 0, skippedTransfers: 1 });
  });

  it('alice, who holds both, still files the pair', async () => {
    const { h, t } = await jointToPrivateFund();
    expect(await bulkUpdate(h, { userId: 'alice' }, [t.fromTxId], { kind: 'setCategory', categoryId: 'sip' })).toMatchObject({ affected: 1 });
  });

  it('a value update takes no category (L12)', async () => {
    const { h, fund } = await jointToPrivateFund();
    const mark = await postValuationMark(h, { userId: 'alice' }, { accountId: fund, targetPaise: 1_70_000_00, date: '2024-06-30' });
    const r = await bulkUpdate(h, { userId: 'alice' }, [mark.id!], { kind: 'setCategory', categoryId: 'sip' });
    expect(r.affected).toBe(0);
    expect(row(h, mark.id!).categoryId).toBeNull();
  });
});
