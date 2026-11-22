/**
 * inbox.test.ts — C5 "To categorize" inbox: pure DERIVED membership.
 * ============================================================================
 * A row is in the inbox iff it is uncategorized ∧ non-transfer ∧ ordinary ∧ in a
 * SPENDING account the viewer can see. Proves: categorize → leaves; clear
 * category → returns; a transfer NEVER enters (the mutation-c1 guard); a
 * force-close balance-adjustment row is excluded via its seeded category (C5 RD4,
 * no special filter); viewer-scoping; count == list length.
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { createAccount, closeAccount } from '../src/lib/server/accounts';
import { createTransfer } from '../src/lib/server/transfers';
import {
  createTransaction,
  updateTransaction,
  bulkUpdate,
  inboxTransactions,
  inboxCount,
} from '../src/lib/server/transactions';
import { seedStarterCategories } from '../src/lib/server/seed';

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
  h.db.insert(schema.categories).values({ id: 'c1', groupId: 'g1', name: 'Groceries' }).run();
  return h;
}

async function acct(h: Db, owner = 'owner1', type = 'bank'): Promise<string> {
  const a = await createAccount(h, {
    ownerId: owner, type, name: `A-${Math.random().toString(36).slice(2, 8)}`,
    currency: 'INR', openingPaise: 0, openingDate: null,
  });
  return a.id;
}
const U = { userId: 'owner1' };

describe('inbox membership (derived)', () => {
  it('an uncategorized ordinary spending row appears; categorizing removes it', async () => {
    const h = seed();
    const a = await acct(h);
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -50_00 });
    expect((await inboxTransactions(h, 'owner1')).map((r) => r.id)).toEqual([tx.id]);
    await updateTransaction(h, U, tx.id, { categoryId: 'c1' }, tx.updatedAt);
    expect(await inboxTransactions(h, 'owner1')).toEqual([]);
  });

  it('clearing a category returns the row to the inbox', async () => {
    const h = seed();
    const a = await acct(h);
    const tx = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -50_00, categoryId: 'c1' });
    expect(await inboxTransactions(h, 'owner1')).toEqual([]);
    const row = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, tx.id)).get()!;
    await updateTransaction(h, U, tx.id, { categoryId: null }, row.updatedAt);
    expect((await inboxTransactions(h, 'owner1')).map((r) => r.id)).toEqual([tx.id]);
  });

  it('a transfer NEVER appears in the inbox', async () => {
    const h = seed();
    const a = await acct(h);
    const b = await acct(h);
    await createTransfer(h, U, { fromId: a, toId: b, amountPaise: 100_00, date: '2024-02-01' });
    expect(await inboxTransactions(h, 'owner1')).toEqual([]);
  });

  it('a force-close balance-adjustment row is excluded (seeded category, no special filter)', async () => {
    // Fresh DB with ONLY the starter categories seeded — `seedStarterCategories`
    // is idempotent and no-ops if any category already exists, so it must run on
    // a clean taxonomy for the Balance-adjustment category to be created.
    const h = createDb(':memory:');
    handle = h;
    for (const stmt of allStatements()) h.sqlite.exec(stmt);
    h.db.insert(schema.users).values({ id: 'owner1', username: 'o1', displayName: 'Owner 1', role: 'admin' }).run();
    await seedStarterCategories(h.db);
    const a = await createAccount(h, {
      ownerId: 'owner1', type: 'bank', name: 'ToClose', currency: 'INR',
      openingPaise: 500_00, openingDate: '2024-01-01',
    });
    await closeAccount(h, a.id, { actingUserId: 'owner1' }); // posts a CATEGORIZED adjustment
    // The adjustment carries the seeded Balance-adjustment category, so the
    // derived inbox rule excludes it with no special-case filter (C5 RD4).
    expect(await inboxTransactions(h, 'owner1')).toEqual([]);
  });

  it('is viewer-scoped: another owner\'s uncategorized row is not shown', async () => {
    const h = seed();
    const theirs = await acct(h, 'owner2');
    await createTransaction(h, { userId: 'owner2' }, { accountId: theirs, date: '2024-02-01', amountPaise: -10_00 });
    expect(await inboxTransactions(h, 'owner1')).toEqual([]);
  });

  it('count equals the list length; bulk-categorize empties it', async () => {
    const h = seed();
    const a = await acct(h);
    const t1 = await createTransaction(h, U, { accountId: a, date: '2024-02-01', amountPaise: -10_00 });
    const t2 = await createTransaction(h, U, { accountId: a, date: '2024-02-02', amountPaise: -20_00 });
    expect(await inboxCount(h, 'owner1')).toBe(2);
    await bulkUpdate(h, U, [t1.id, t2.id], { kind: 'setCategory', categoryId: 'c1' });
    expect(await inboxCount(h, 'owner1')).toBe(0);
  });
});
