/**
 * inline-transfer.test.ts: "Transfer → <account>" typed as a payee makes a linked pair, the same way
 * from the register's entry row and from Quick Add (Quick Add works like the
 * register, no type tabs). Withdrawal = money out of this account, Deposit = money in; a category is
 * kept only when the pair takes one; across currencies the other account's amount is required.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance } from '../src/lib/server/db/balances';
import { createAccount } from '../src/lib/server/accounts';
import { addInlineTransfer, isInlineTransfer } from '../src/lib/server/inline-transfer';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

function seed(): Db {
  const h = createDb(':memory:');
  handle = h;
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db.insert(schema.users).values([{ id: 'u1', username: 'u1', displayName: 'Alice', role: 'admin' }]).run();
  h.db.insert(schema.categoryGroups).values([
    { id: 'g-live', name: 'Living', kind: 'spending' },
    { id: 'g-inv', name: 'Investments', kind: 'neutral' },
  ]).run();
  h.db.insert(schema.categories).values([
    { id: 'groc', groupId: 'g-live', name: 'Groceries' },
    { id: 'sip', groupId: 'g-inv', name: 'SIP' },
  ]).run();
  return h;
}
async function acct(h: Db, type: string, name: string, currency = 'INR'): Promise<string> {
  const a = await createAccount(h, {
    ownerId: 'u1', type, name, currency, openingPaise: type === 'bank' ? 1_00_000_00 : 0, openingDate: '2024-01-01',
  });
  return a.id;
}
const base = { date: '2024-03-05', notes: null, categoryId: null, received: '' };
const legs = (h: Db) => h.db.select().from(schema.transactions).all().filter((t) => t.transferPartnerId !== null);

describe('a transfer typed as a payee', () => {
  it('recognises the marker only', () => {
    expect(isInlineTransfer('Transfer → HDFC')).toBe(true);
    expect(isInlineTransfer('Transfer to HDFC')).toBe(false);
    expect(isInlineTransfer(null)).toBe(false);
  });

  it('a withdrawal moves money out of this account into the named one, a deposit the other way', async () => {
    const h = seed();
    const hdfc = await acct(h, 'bank', 'HDFC');
    const sbi = await acct(h, 'bank', 'SBI');
    expect(await addInlineTransfer(h, 'u1', hdfc, { ...base, payeeName: 'Transfer → SBI', amountPaise: -5_000_00 })).toBeNull();
    expect(accountBalance(h.sqlite, hdfc)).toBe(1_00_000_00 - 5_000_00);
    expect(accountBalance(h.sqlite, sbi)).toBe(1_00_000_00 + 5_000_00);
    expect(await addInlineTransfer(h, 'u1', hdfc, { ...base, payeeName: 'Transfer → SBI', amountPaise: 2_000_00 })).toBeNull();
    expect(accountBalance(h.sqlite, hdfc)).toBe(1_00_000_00 - 3_000_00);
    expect(legs(h)).toHaveLength(4);
  });

  it('keeps a category only when the pair takes one (bank ↔ holding), drops it bank ↔ bank', async () => {
    const h = seed();
    const hdfc = await acct(h, 'bank', 'HDFC');
    await acct(h, 'bank', 'SBI');
    const mf = await acct(h, 'mutualFunds', 'Index fund');
    await addInlineTransfer(h, 'u1', hdfc, { ...base, payeeName: 'Transfer → SBI', amountPaise: -1_000_00, categoryId: 'groc' });
    await addInlineTransfer(h, 'u1', hdfc, { ...base, payeeName: 'Transfer → Index fund', amountPaise: -1_000_00, categoryId: 'sip' });
    const cats = legs(h).filter((t) => t.accountId === hdfc).map((t) => t.categoryId).sort();
    expect(cats).toEqual([null, 'sip'].sort());
    expect(mf).toBeTruthy();
  });

  it('names a missing account and asks for the other amount across currencies', async () => {
    const h = seed();
    const hdfc = await acct(h, 'bank', 'HDFC');
    await acct(h, 'bank', 'US Checking', 'USD');
    expect(await addInlineTransfer(h, 'u1', hdfc, { ...base, payeeName: 'Transfer → Nowhere', amountPaise: -100 })).toEqual({ payee: 'No such account to transfer to' });
    expect(await addInlineTransfer(h, 'u1', hdfc, { ...base, payeeName: 'Transfer → US Checking', amountPaise: -8_310_00 })).toEqual({ received: 'Enter the amount in USD' });
    expect(await addInlineTransfer(h, 'u1', hdfc, { ...base, payeeName: 'Transfer → US Checking', amountPaise: -8_310_00, received: '100' })).toBeNull();
    expect(legs(h)).toHaveLength(2);
  });
});
