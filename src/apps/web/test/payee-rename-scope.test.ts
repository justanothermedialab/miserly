/**
 * payee-rename-scope.test.ts: a rename or merge by a member who joined a shared account later
 * doesn't put the new name in the owner's payee list. Only an account where
 * a row of the actor's moved, or one they hold on every date, records the new payee.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import * as schema from '../src/lib/server/db/schema';
import { createAccount } from '../src/lib/server/accounts';
import { createTransaction } from '../src/lib/server/transactions';
import { listPayeesFor, mergePayeesFor, renamePayeeFor } from '../src/lib/server/payees';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

async function household() {
  const h = createDb(':memory:');
  handle = h;
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db.insert(schema.users).values([
    { id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
    { id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' },
  ]).run();
  const open = async (ownerId: string, name: string) =>
    (await createAccount(h, { ownerId, type: 'bank', name, currency: 'INR', openingPaise: 1_00_000_00, openingDate: '2026-01-01' })).id;
  const joint = await open('alice', 'Joint');
  const bobs = await open('bob', 'Bob own');
  // Bob holds the joint account from 1 Nov 2026.
  h.db.insert(schema.accountMembers).values({ accountId: joint, userId: 'bob' }).run();
  h.db.insert(schema.accountHolderPeriods).values({ accountId: joint, userId: 'bob', fromDate: '2026-11-01', toDate: null }).run();
  await createTransaction(h, { userId: 'alice' }, { accountId: joint, date: '2026-10-01', amountPaise: -20_000_00, payeeName: 'Landlord' });
  await createTransaction(h, { userId: 'bob' }, { accountId: bobs, date: '2026-10-15', amountPaise: -5_000_00, payeeName: 'Landlord' });
  const landlord = h.db.select().from(schema.payees).where(eq(schema.payees.displayName, 'Landlord')).get()!.id;
  return { h, joint, bobs, landlord };
}

const names = async (h: Db, userId: string) => (await listPayeesFor(h.db, userId)).map((p) => p.displayName).sort();

describe('S18: a later-joined member renames a payee the owner also uses', () => {
  it("the new name stays out of the owner's list; the owner keeps the old one", async () => {
    const { h, landlord } = await household();
    await renamePayeeFor(h.db, 'bob', landlord, 'Sharma, loan');
    expect(await names(h, 'alice')).toEqual(['Landlord']);
    expect(await names(h, 'bob')).toContain('Sharma, loan');
  });

  it('a merge into a private payee does the same', async () => {
    const { h, landlord, bobs } = await household();
    await createTransaction(h, { userId: 'bob' }, { accountId: bobs, date: '2026-10-20', amountPaise: -1_00, payeeName: 'Mr Sharma' });
    const sharma = h.db.select().from(schema.payees).where(eq(schema.payees.displayName, 'Mr Sharma')).get()!.id;
    await mergePayeesFor(h.db, 'bob', sharma, [landlord]);
    expect(await names(h, 'alice')).toEqual(['Landlord']);
  });
});
