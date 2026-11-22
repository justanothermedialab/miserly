/**
 * sharing-small.test.ts: the third read's smaller things. The split's date a
 * later member reads; a rate's currency code; a family (an EPF and its EPS) shared all or nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { formatDate, today } from '@miserly/core';
import { createDb, type Db } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import * as schema from '../src/lib/server/db/schema';
import { createAccount, createChildAccount } from '../src/lib/server/accounts';
import { setAccountShares, shareAccount, splitState, unshareAccount } from '../src/lib/server/sharing';
import { setRate } from '../src/lib/server/rates';
import { appClock } from '../src/lib/server/clock';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

function fresh() {
  const h = createDb(':memory:');
  handle = h;
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db.insert(schema.users).values([
    { id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
    { id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' },
    { id: 'carol', username: 'carol', displayName: 'Carol', role: 'member' },
  ]).run();
  return h;
}
const todayIso = () => formatDate(today(appClock()));
const granted = (h: Db, accountId: string, userId: string) =>
  h.db
    .select()
    .from(schema.accountMembers)
    .where(and(eq(schema.accountMembers.accountId, accountId), eq(schema.accountMembers.userId, userId), isNull(schema.accountMembers.deletedAt)))
    .get() !== undefined;

describe("S24: the split's date a later member reads", () => {
  it('Bob, who joined today, reads no From before his own first day; Alice reads the real one', async () => {
    const h = fresh();
    const joint = (await createAccount(h, { ownerId: 'alice', type: 'bank', name: 'Joint', currency: 'INR', openingPaise: 1_000_00, openingDate: '2023-01-01' })).id;
    // Alice and Carol stated a split from 1 Jan 2024; Carol has since left.
    h.db.insert(schema.accountMembers).values({ accountId: joint, userId: 'carol', deletedAt: '2025-01-01T00:00:00.000Z' }).run();
    h.db.insert(schema.accountHolderPeriods).values({ accountId: joint, userId: 'carol', fromDate: '2023-06-01', toDate: '2025-01-01' }).run();
    h.db.insert(schema.accountShares).values([
      { accountId: joint, userId: 'alice', effectiveFrom: '2024-01-01', shareBp: 5000 },
      { accountId: joint, userId: 'carol', effectiveFrom: '2024-01-01', shareBp: 5000 },
    ]).run();
    await shareAccount(h.db, { userId: 'alice' }, joint, 'bob');
    expect((await splitState(h.db, 'bob', joint)).statedFrom).toBe(todayIso());
    expect((await splitState(h.db, 'alice', joint)).statedFrom).toBe('2024-01-01');
  });
});

describe("S24: a rate's currency is three letters", () => {
  it.each(['US', 'USDX', 'U$D', '12A', ''])('%j is refused', (code) => {
    const h = fresh();
    expect(() => setRate(h, code, { scaled: 83_000_000, scale: 6 })).toThrow();
  });
  it('usd is taken as USD', () => {
    const h = fresh();
    expect(() => setRate(h, 'usd', { scaled: 83_000_000, scale: 6 })).not.toThrow();
  });
});

describe('S24: an EPF and its EPS are shared all or nothing', () => {
  async function family(h: Db) {
    const epf = (await createAccount(h, { ownerId: 'alice', type: 'epf', name: 'EPF', currency: 'INR', openingPaise: 5_00_000_00, openingDate: '2024-04-01' })).id;
    const eps = (await createChildAccount(h, epf, 1_00_000_00, '2024-04-01')).id;
    return { epf, eps };
  }

  it('when the second account would fail, the first is not shared either', async () => {
    const h = fresh();
    const { epf, eps } = await family(h);
    // Force a failure on the EPS (not reachable through the app): it belongs to someone else.
    h.db.update(schema.accounts).set({ ownerId: 'carol' }).where(eq(schema.accounts.id, eps)).run();
    await expect(shareAccount(h.db, { userId: 'alice' }, epf, 'bob')).rejects.toThrow();
    expect(granted(h, epf, 'bob')).toBe(false);
  });

  it('the same for unsharing and for a split', async () => {
    const h = fresh();
    const { epf, eps } = await family(h);
    await shareAccount(h.db, { userId: 'alice' }, epf, 'bob');
    h.db.update(schema.accounts).set({ ownerId: 'carol' }).where(eq(schema.accounts.id, eps)).run();
    await expect(setAccountShares(h.db, { userId: 'alice' }, epf, todayIso(), { alice: 5000, bob: 5000 })).rejects.toThrow();
    expect(h.db.select().from(schema.accountShares).where(eq(schema.accountShares.accountId, epf)).all()).toEqual([]);
    await expect(unshareAccount(h.db, { userId: 'alice' }, epf, 'bob')).rejects.toThrow();
    expect(granted(h, epf, 'bob')).toBe(true);
  });
});
