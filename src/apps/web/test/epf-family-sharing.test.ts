/**
 * epf-family-sharing.test.ts: an EPF and its EPS share as one (answered by the
 * third read: nothing to fix in closeRefusal). Sharing the EPF, or the EPS, gives the other the
 * same holder from the same day; unsharing ends both. So "Its EPS still holds money" only ever
 * reaches people who hold the EPS.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { formatDate, today } from '@miserly/core';
import { createDb, type Db } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import * as schema from '../src/lib/server/db/schema';
import { createAccount, createChildAccount } from '../src/lib/server/accounts';
import { shareAccount, unshareAccount } from '../src/lib/server/sharing';
import { accountsVisibleTo } from '../src/lib/server/visibility';
import { appClock } from '../src/lib/server/clock';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

async function epfWithEps() {
  const h = createDb(':memory:');
  handle = h;
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db.insert(schema.users).values([
    { id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
    { id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' },
  ]).run();
  const epf = (await createAccount(h, { ownerId: 'alice', type: 'epf', name: 'EPF', currency: 'INR', openingPaise: 5_00_000_00, openingDate: '2024-04-01' })).id;
  const eps = (await createChildAccount(h, epf, 1_00_000_00, '2024-04-01')).id;
  return { h, epf, eps };
}

const stretches = (h: Db, accountId: string) =>
  h.db
    .select({ from: schema.accountHolderPeriods.fromDate, to: schema.accountHolderPeriods.toDate })
    .from(schema.accountHolderPeriods)
    .where(and(eq(schema.accountHolderPeriods.accountId, accountId), eq(schema.accountHolderPeriods.userId, 'bob')))
    .all();
const grant = (h: Db, accountId: string) =>
  h.db
    .select()
    .from(schema.accountMembers)
    .where(and(eq(schema.accountMembers.accountId, accountId), eq(schema.accountMembers.userId, 'bob'), isNull(schema.accountMembers.deletedAt)))
    .get();

describe('S21: an EPF and its EPS are shared and unshared together', () => {
  it.each(['epf', 'eps'] as const)('sharing the %s gives Bob both, from the same day; unsharing ends both', async (which) => {
    const { h, epf, eps } = await epfWithEps();
    const todayIso = formatDate(today(appClock()));
    await shareAccount(h.db, { userId: 'alice' }, which === 'epf' ? epf : eps, 'bob');
    expect((await accountsVisibleTo(h.db, 'bob')).sort()).toEqual([epf, eps].sort());
    expect(stretches(h, epf)).toEqual([{ from: todayIso, to: null }]);
    expect(stretches(h, eps)).toEqual(stretches(h, epf));

    await unshareAccount(h.db, { userId: 'alice' }, which === 'epf' ? epf : eps, 'bob');
    expect(await accountsVisibleTo(h.db, 'bob')).toEqual([]);
    expect(grant(h, epf)).toBeUndefined();
    expect(grant(h, eps)).toBeUndefined();
    expect(stretches(h, eps)).toEqual(stretches(h, epf));
    expect(stretches(h, epf).every((s) => s.to !== null)).toBe(true);
  });
});
