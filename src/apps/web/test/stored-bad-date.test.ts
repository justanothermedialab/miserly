/**
 * stored-bad-date.test.ts: one stored row whose date is not a day of the calendar ('2026-02-31',
 * written by a hand edit of the file or a future bug; the app refuses it at every write, S20)
 * must not take every page down for its holder (hosted audit H2). The read side takes such a date
 * as the nearest real day of its month, so the pages load, the row still counts, and the person
 * can open the register and give it a real date.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DB_PATH = path.join(os.tmpdir(), `miserly-bad-date-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { createAccount } from '../src/lib/server/accounts';
import { createTransaction, updateTransaction } from '../src/lib/server/transactions';
import { postValuationMark } from '../src/lib/server/marks';
import { dashboardSummary } from '../src/lib/server/dashboard';
import { nearestRealDate } from '../src/lib/dates';
import { load as layoutLoad } from '../src/routes/+layout.server';
import { load as dashboardLoad } from '../src/routes/+page.server';
import { load as accountsLoad } from '../src/routes/accounts/+page.server';
import { load as registerLoad } from '../src/routes/accounts/[id]/+page.server';
import { load as reportsLoad } from '../src/routes/reports/+page.server';
import { load as sectionLoad } from '../src/routes/sections/[type]/+page.server';
import { load as transactionsLoad } from '../src/routes/transactions/+page.server';
import { load as inboxLoad } from '../src/routes/inbox/+page.server';
import { eq } from 'drizzle-orm';

let user: { id: string; username: string; role: 'admin' };
let bankId = '';
let fundId = '';
let badId = '';

afterAll(() => {
  getDb().sqlite.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});

beforeAll(async () => {
  const h = getDb();
  const alice = await createAdmin(h.db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  user = { id: alice.id, username: 'alice', role: 'admin' };
  const open = (type: string, name: string) =>
    createAccount(h, { ownerId: alice.id, type, name, currency: 'INR', openingPaise: 1_000_00, openingDate: '2026-01-01' });
  const bank = await open('bank', 'Bank');
  const fund = await open('mutualFunds', 'Fund');
  bankId = bank.id;
  fundId = fund.id;
  const actor = { userId: alice.id };
  await createTransaction(h, actor, { accountId: bank.id, date: '2026-02-10', amountPaise: -200_00 });
  await postValuationMark(h, actor, { accountId: fund.id, targetPaise: 1_500_00, date: '2026-03-05' });
  // The impossible rows, straight into the file as a hand edit would put them.
  badId = randomUUID();
  h.db.insert(schema.transactions)
    .values({ id: badId, accountId: bank.id, date: '2026-02-31', sequence: 9, amountPaise: -100_00, enteredBy: alice.id })
    .run();
  // An account whose stored opening date is impossible: its balance starts there.
  const card = await createAccount(h, { ownerId: alice.id, type: 'bank', name: 'Card', currency: 'INR', openingPaise: 0, openingDate: '2026-01-05' });
  h.db.update(schema.accounts).set({ openingDate: '2025-02-29' }).where(eq(schema.accounts.id, card.id)).run();
  h.db.insert(schema.transactions)
    .values({ id: randomUUID(), accountId: fund.id, date: '2026-06-31', sequence: 9, amountPaise: 50_00, enteredBy: alice.id })
    .run();
});

const req = (u: string) => ({
  locals: { user },
  url: new URL(`http://localhost${u}`),
  request: new Request(`http://localhost${u}`),
  cookies: { get: () => undefined },
  depends: () => {},
});

describe('nearestRealDate', () => {
  it.each([
    ['2026-02-31', '2026-02-28'],
    ['2024-02-30', '2024-02-29'],
    ['2026-04-31', '2026-04-30'],
    ['2026-13-01', '2026-12-01'],
    ['2026-00-10', '2026-01-10'],
    ['2026-03-00', '2026-03-01'],
    ['2026-03-15', '2026-03-15'],
  ])('%s reads as %s', (stored, read) => expect(nearestRealDate(stored)).toBe(read));
  it('leaves text that is not YYYY-MM-DD alone', () => expect(nearestRealDate('not a date')).toBe('not a date'));
});

describe('H2: a stored impossible date', () => {
  it('the layout loads, and the totals still count the row', async () => {
    const data = (await layoutLoad(req('/') as never)) as { nav: { netWorthPaise: number } };
    // Bank 1,000 - 200 - 100 = 700; fund 1,500 + 50 = 1,550.
    expect(data.nav.netWorthPaise).toBe(2_250_00);
    expect((await dashboardSummary(getDb(), user.id)).netWorthPaise).toBe(2_250_00);
  });

  it.each([
    ['the dashboard', () => dashboardLoad(req('/') as never)],
    ['the dashboard, all time', () => dashboardLoad(req('/?range=ALL') as never)],
    ['accounts', () => accountsLoad(req('/accounts') as never)],
    ['the bank register', () => registerLoad({ ...req(`/accounts/${bankId}`), params: { id: bankId } } as never)],
    ['the fund register', () => registerLoad({ ...req(`/accounts/${fundId}`), params: { id: fundId } } as never)],
    ['reports', () => reportsLoad(req('/reports') as never)],
    ['reports, all time', () => reportsLoad(req('/reports?preset=all') as never)],
    ['the bank section', () => sectionLoad({ ...req('/sections/bank'), params: { type: 'bank' } } as never)],
    ['the funds section', () => sectionLoad({ ...req('/sections/mutualFunds'), params: { type: 'mutualFunds' } } as never)],
    ['all transactions', () => transactionsLoad(req('/transactions') as never)],
    ['the inbox', () => inboxLoad(req('/inbox') as never)],
  ])('%s loads', async (_name, run) => {
    await expect(run()).resolves.toBeDefined();
  });

  it('the person can give the row a real date', async () => {
    const h = getDb();
    const row = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, badId)).get()!;
    await updateTransaction(h, { userId: user.id }, badId, { date: '2026-02-28' }, row.updatedAt);
    expect(h.db.select().from(schema.transactions).where(eq(schema.transactions.id, badId)).get()!.date).toBe('2026-02-28');
  });
});
