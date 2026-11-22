/**
 * server-speed.test.ts: the server's cost per page. The figures
 * can't change, only what it takes to make them: no page reads a note it doesn't show, and the
 * layout and the dashboard read the SQL the test sees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-server-speed-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { load as layoutLoad } from '../src/routes/+layout.server';
import { load as dashboardLoad } from '../src/routes/+page.server';
import { inboxCount, inboxTransactions } from '../src/lib/server/transactions';
import { inLedgerScope } from '../src/lib/server/ledger-cuts';

let alice: AuthedUser;
let bankId: string;
let fundId: string;

/** Every SQL statement prepared while `fn` runs. */
async function statementsOf(fn: () => Promise<unknown>): Promise<string[]> {
  const { sqlite } = getDb();
  const seen: string[] = [];
  const prepare = sqlite.prepare;
  sqlite.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare.call(sqlite, sql);
  }) as typeof sqlite.prepare;
  try {
    await fn();
  } finally {
    sqlite.prepare = prepare;
  }
  return seen;
}

const layout = () =>
  (layoutLoad as (e: never) => Promise<Record<string, unknown>>)({
    locals: { user: alice },
    request: new Request('http://localhost/'),
    cookies: { get: () => undefined },
    depends: () => {},
  } as never);
const dashboard = () =>
  (dashboardLoad as (e: never) => Promise<Record<string, unknown>>)({
    locals: { user: alice },
    url: new URL('http://localhost/'),
  } as never);

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  bankId = randomUUID();
  fundId = randomUUID();
  db.insert(schema.accounts)
    .values([
      { id: bankId, ownerId: alice.id, name: 'HDFC', type: 'bank', currency: 'INR', openingPaise: 1000_00, openingDate: '2024-01-01' },
      { id: fundId, ownerId: alice.id, name: 'Index fund', type: 'mutualFunds', currency: 'INR', openingPaise: 500_00, openingDate: '2024-01-01' },
    ])
    .run();
  db.insert(schema.transactions)
    .values([
      { id: randomUUID(), accountId: bankId, date: '2024-02-01', sequence: 1, amountPaise: -250_00, notes: 'a note', enteredBy: alice.id, kind: 'ordinary' },
      { id: randomUUID(), accountId: fundId, date: '2024-03-01', sequence: 1, amountPaise: 100_00, notes: 'another', enteredBy: alice.id, kind: 'ordinary' },
    ])
    .run();
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('no page reads a note it never shows', () => {
  it("the layout (every page) and the dashboard read no transaction's notes", async () => {
    const sql = await statementsOf(async () => {
      await layout();
      await dashboard();
    });
    expect(sql.length).toBeGreaterThan(0);
    // `NULL AS notes` (a feed that doesn't show them) reads none.
    expect(sql.filter((s) => /\bnotes\b/i.test(s.replace(/NULL AS notes/g, '')))).toEqual([]);
  });

  it("the sidebar's Inbox count is the Inbox list's length", async () => {
    expect(await inboxCount(getDb(), alice.id)).toBe((await inboxTransactions(getDb(), alice.id)).length);
    expect(await inboxCount(getDb(), alice.id)).toBe(1); // the bank row; a fund's isn't spending
  });

  it("the dashboard's Recent activity carries no note", async () => {
    const data = (await dashboard()) as { activity: { notes: string | null }[] };
    expect(data.activity.length).toBe(2);
    expect(data.activity.every((r) => r.notes === null)).toBe(true);
  });
});

/** How many rows every statement run while `fn` runs hands back to JavaScript. */
async function rowsReadBy(fn: () => Promise<unknown>): Promise<number> {
  const { sqlite } = getDb();
  let rows = 0;
  const prepare = sqlite.prepare;
  sqlite.prepare = ((sql: string) => {
    const st = prepare.call(sqlite, sql);
    const all = st.all.bind(st);
    const get = st.get.bind(st);
    st.all = ((...a: unknown[]) => {
      const r = (all as (...x: unknown[]) => unknown[])(...a);
      rows += r.length;
      return r;
    }) as typeof st.all;
    st.get = ((...a: unknown[]) => {
      const r = (get as (...x: unknown[]) => unknown)(...a);
      if (r !== undefined) rows += 1;
      return r;
    }) as typeof st.get;
    return st;
  }) as typeof sqlite.prepare;
  try {
    await fn();
  } finally {
    sqlite.prepare = prepare;
  }
  return rows;
}

describe("the layout's cost doesn't grow with the history", () => {
  it("an owner's rows need no per-row check of the dates held (the Inbox count, Quick add's payees)", async () => {
    const sql = await statementsOf(layout);
    expect(sql.filter((s) => /account_holder_periods hp WHERE hp\.account_id = "transactions"/.test(s)).map((s) => s.slice(0, 120))).toEqual([]);
  });

  it('the same statements with 2 accounts or 12 (no query per account)', async () => {
    const before = await statementsOf(layout);
    const { db } = getDb();
    for (let i = 0; i < 10; i++) {
      const id = randomUUID();
      db.insert(schema.accounts).values({ id, ownerId: alice.id, name: `Bank ${i}`, type: 'bank', currency: 'INR', openingPaise: 100_00, openingDate: '2024-01-01' }).run();
      db.insert(schema.transactions)
        .values(Array.from({ length: 20 }, (_, k) => ({ id: randomUUID(), accountId: id, date: `2024-0${1 + (k % 9)}-1${k % 10}`, sequence: k, amountPaise: -k * 100, enteredBy: alice.id, kind: 'ordinary' as const })))
        .run();
    }
    expect((await statementsOf(layout)).length).toBe(before.length);
  });

  it('the same rows read with 300 more transactions (sums, not rows)', async () => {
    const { db } = getDb();
    const groceries = randomUUID();
    const group = randomUUID();
    db.insert(schema.categoryGroups).values({ id: group, name: 'Spending', kind: 'spending' }).run();
    db.insert(schema.categories).values({ id: groceries, groupId: group, name: 'Groceries' }).run();
    // Categorised transfers into the fund (Quick add remembers the latest one's category).
    const transfer = (k: number) => {
      const out = randomUUID();
      const into = randomUUID();
      db.insert(schema.transactions)
        .values([
          { id: out, accountId: bankId, date: `2025-10-${10 + (k % 18)}`, sequence: 100 + k, amountPaise: -1_000_00, categoryId: groceries, transferPartnerId: into, enteredBy: alice.id, kind: 'ordinary' as const },
          { id: into, accountId: fundId, date: `2025-10-${10 + (k % 18)}`, sequence: 100 + k, amountPaise: 1_000_00, transferPartnerId: out, enteredBy: alice.id, kind: 'ordinary' as const },
        ])
        .run();
    };
    transfer(0);
    const before = await rowsReadBy(layout);
    db.insert(schema.transactions)
      .values(Array.from({ length: 200 }, (_, k) => ({ id: randomUUID(), accountId: bankId, date: `2025-0${1 + (k % 9)}-2${k % 8}`, sequence: k, amountPaise: -k * 100, categoryId: k % 2 ? groceries : null, enteredBy: alice.id, kind: 'ordinary' as const })))
      .run();
    for (let k = 1; k < 50; k++) transfer(k);
    expect(await rowsReadBy(layout)).toBe(before);
  });
});

describe('one request sums the ledger once, and the figures are the same', () => {
  const sums = (sql: string[]) => sql.filter((s) => /GROUP BY b\.account_id/.test(s)).length;
  const dashboardAt = (range: string) => () =>
    (dashboardLoad as (e: never) => Promise<Record<string, unknown>>)({ locals: { user: alice }, url: new URL(`http://localhost/?range=${range}`) } as never);

  it("the layout and the dashboard's 1M chart: one grouped sum", async () => {
    const sql = await statementsOf(() => inLedgerScope(async () => {
      await layout();
      await dashboardAt('1M')();
    }));
    expect(sums(sql)).toBe(1);
  });

  it('the same data with the request memo as without it', async () => {
    for (const range of ['1M', '1Y', 'ALL']) {
      const plain = { layout: await layout(), page: await dashboardAt(range)() };
      const scoped = await inLedgerScope(async () => ({ layout: await layout(), page: await dashboardAt(range)() }));
      expect(scoped).toEqual(plain);
    }
  });

  it('a write inside the request is summed afresh', async () => {
    await inLedgerScope(async () => {
      const before = ((await layout()).nav as { netWorthPaise: number }).netWorthPaise;
      getDb().db.insert(schema.transactions).values({ id: randomUUID(), accountId: bankId, date: '2024-05-05', sequence: 99, amountPaise: -7_00, enteredBy: alice.id, kind: 'ordinary' }).run();
      expect(((await layout()).nav as { netWorthPaise: number }).netWorthPaise).toBe(before - 7_00);
    });
  });
});
