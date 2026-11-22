/**
 * list-pages.integration.test.ts: long lists load by pages. All
 * transactions, a register and the Inbox send their first page with the page and the rest as the
 * person scrolls, keyed on `(date, sequence)`. Each case holds the pages, put end to end, to the
 * whole list read at once: the same rows in the same order, a transfer once, nothing of another
 * member's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-list-pages-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin, createMember } from '../src/lib/server/auth/users';
import { createTransaction, registerView, registerCursorText, parseRegisterCursor, type RegisterCursor } from '../src/lib/server/transactions';
import { shareAccount } from '../src/lib/server/sharing';
import { inboxTransactions, inboxPage, inboxSummary, type InboxCursor } from '../src/lib/server/transactions';
import { GET as inboxRows } from '../src/routes/inbox/rows/+server';
import { load as inboxLoad } from '../src/routes/inbox/+page.server';
import { GET as registerRows } from '../src/routes/accounts/[id]/rows/+server';
import { load as registerLoad } from '../src/routes/accounts/[id]/+page.server';
import { createTransfer } from '../src/lib/server/transfers';
import { activityPage, recentActivity, cursorText, parseCursor, type ActivityRow } from '../src/lib/server/dashboard';
import { GET as txRows } from '../src/routes/transactions/rows/+server';
import { load as txLoad } from '../src/routes/transactions/+page.server';
import { FIRST_PAGE, MAX_FIRST } from '../src/lib/list-pages';

let alice: AuthedUser;
let bob: AuthedUser;
const acc = { a: randomUUID(), b: randomUUID(), fund: randomUUID(), bobs: randomUUID() };

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  bob = await createMember(db, { username: 'bob', displayName: 'Bob', tempPassword: 'bob-temp-password-1' });
  db.insert(schema.accounts)
    .values([
      { id: acc.a, ownerId: alice.id, name: 'HDFC', type: 'bank', currency: 'INR', openingPaise: 50_000_00, openingDate: '2024-01-01' },
      { id: acc.b, ownerId: alice.id, name: 'SBI', type: 'bank', currency: 'INR', openingPaise: 10_000_00, openingDate: '2024-01-01' },
      { id: acc.fund, ownerId: alice.id, name: 'Index fund', type: 'mutualFunds', currency: 'INR', openingPaise: 0, openingDate: null },
      { id: acc.bobs, ownerId: bob.id, name: 'Bob bank', type: 'bank', currency: 'INR', openingPaise: 0, openingDate: null },
    ])
    .run();
  const actor = { userId: alice.id };
  // Many rows on few dates, in both banks (so `sequence` ties across accounts), and transfers
  // both ways, some on dates where the receiving leg sorts first.
  for (let i = 0; i < 90; i++) {
    const date = `2025-0${1 + (i % 4)}-1${i % 3}`;
    await createTransaction(getDb(), actor, { accountId: i % 2 ? acc.a : acc.b, date, amountPaise: -(100_00 + i), payeeName: `Shop ${i % 7}`, notes: i % 9 ? null : 'gift' });
    if (i % 6 === 0) await createTransfer(getDb(), actor, { fromId: i % 12 ? acc.a : acc.b, toId: i % 12 ? acc.b : acc.a, date, amountPaise: 500_00 + i });
    if (i % 15 === 0) await createTransfer(getDb(), actor, { fromId: acc.a, toId: acc.fund, date, amountPaise: 1_000_00 + i });
  }
  await createTransaction(getDb(), { userId: bob.id }, { accountId: acc.bobs, date: '2025-02-11', amountPaise: -42_00, payeeName: 'Shop 1' });
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

async function allPages(limit: number, q?: string): Promise<ActivityRow[]> {
  const out: ActivityRow[] = [];
  let after = null;
  for (let i = 0; i < 1000; i++) {
    const page: Awaited<ReturnType<typeof activityPage>> = await activityPage(getDb(), alice.id, { limit, q, after });
    out.push(...page.rows);
    if (!page.next) return out;
    // The cursor goes to the page as text and comes back.
    after = parseCursor(cursorText(page.next));
  }
  throw new Error('no end');
}

describe('All transactions by pages', () => {
  it('pages end to end are the whole feed: the same rows, in order, each transfer once', async () => {
    const whole = await recentActivity(getDb(), alice.id, 10_000);
    const transfers = whole.filter((r) => r.entryType === 'transfer');
    expect(transfers.length).toBeGreaterThan(10);
    // Each transfer once: no two rows for one pair.
    const pairs = transfers.map((r) => [r.id, r.transferPartnerId].sort().join('|'));
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const limit of [1, 2, 7, 50]) {
      const paged = await allPages(limit);
      expect(paged.map((r) => r.id)).toEqual(whole.map((r) => r.id));
      expect(paged).toEqual(whole);
    }
  });

  it('a search pages the same way', async () => {
    for (const q of ['gift', 'SBI', 'Shop 3']) {
      const whole = await recentActivity(getDb(), alice.id, 10_000, q);
      expect(whole.length).toBeGreaterThan(0);
      expect((await allPages(3, q)).map((r) => r.id)).toEqual(whole.map((r) => r.id));
    }
  });

  it('the endpoint answers the next page for the viewer only; a bad cursor is refused', async () => {
    const call = (user: AuthedUser | null, query: string) =>
      txRows({ locals: { user }, url: new URL(`http://localhost/transactions/rows?${query}`) } as never);
    const first = (await txLoad({ locals: { user: alice }, url: new URL('http://localhost/transactions?n=5') } as never)) as { rows: ActivityRow[]; next: string | null };
    expect(first.rows).toHaveLength(5);
    const res = await call(alice, `after=${encodeURIComponent(first.next!)}&limit=4`);
    const body = (await res.json()) as { rows: ActivityRow[]; next: string | null };
    const whole = await recentActivity(getDb(), alice.id, 9);
    expect([...first.rows, ...body.rows].map((r) => r.id)).toEqual(whole.map((r) => r.id));
    // Bob's pages never hold Alice's rows, and his one row is all he gets.
    const bobs = (await (await call(bob, `after=${encodeURIComponent('2999-01-01|0|z')}`)).json()) as { rows: ActivityRow[] };
    expect(bobs.rows.map((r) => r.accountId)).toEqual([acc.bobs]);
    await expect(call(null, 'after=x')).rejects.toMatchObject({ status: 401 });
    await expect(call(alice, 'after=not-a-cursor')).rejects.toMatchObject({ status: 400 });
  });

  it('a first load is one page, and `?n=` is capped', async () => {
    const first = (await txLoad({ locals: { user: alice }, url: new URL('http://localhost/transactions?n=999999') } as never)) as { rows: ActivityRow[] };
    expect(first.rows.length).toBeLessThanOrEqual(MAX_FIRST);
  });
});

describe('a register by pages', () => {
  type Row = Awaited<ReturnType<typeof registerView>>['rows'][number];
  async function registerPages(user: AuthedUser, accountId: string, limit: number): Promise<Row[]> {
    let out: Row[] = [];
    let before: RegisterCursor | null = null;
    for (let i = 0; i < 1000; i++) {
      const v: Awaited<ReturnType<typeof registerView>> = await registerView(getDb(), user.id, accountId, { limit, before });
      // Each page is ledger order (oldest first) and older than the rows already here.
      out = [...v.rows, ...out];
      if (v.next === null) return out;
      before = parseRegisterCursor(v.next);
    }
    throw new Error('no end');
  }

  it('pages end to end are the whole register, each row with the same running balance', async () => {
    const whole = await registerView(getDb(), alice.id, acc.a);
    expect(whole.rows.length).toBeGreaterThan(60);
    expect(whole.total).toBe(whole.rows.length);
    expect(whole.next).toBeNull();
    for (const limit of [1, 3, 25]) expect(await registerPages(alice, acc.a, limit)).toEqual(whole.rows);
    const first = await registerView(getDb(), alice.id, acc.a, { limit: 10 });
    expect(first.rows).toEqual(whole.rows.slice(-10));
    expect(first.total).toBe(whole.rows.length);
    expect(first.asOfTodayPaise).toBe(whole.asOfTodayPaise);
  });

  it('every row from a date on (the answer to a save, a link to a row)', async () => {
    const whole = await registerView(getDb(), alice.id, acc.a);
    const from = '2025-03-11';
    const v = await registerView(getDb(), alice.id, acc.a, { from });
    expect(v.rows).toEqual(whole.rows.filter((r) => r.date >= from));
    // The next page is the rows before it.
    const older = await registerView(getDb(), alice.id, acc.a, { limit: 10_000, before: parseRegisterCursor(v.next) });
    expect([...older.rows, ...v.rows]).toEqual(whole.rows);
    // Nothing dated from then on: the next page is everything.
    const none = await registerView(getDb(), alice.id, acc.a, { from: '2099-01-01' });
    expect(none.rows).toEqual([]);
    expect((await registerView(getDb(), alice.id, acc.a, { limit: 10_000, before: parseRegisterCursor(none.next) })).rows).toEqual(whole.rows);
  });

  it('a member who holds it from a date: pages hold only those rows, counted as such (C5 C)', async () => {
    const { db, sqlite } = getDb();
    await shareAccount(db, { userId: alice.id }, acc.a, bob.id);
    sqlite.prepare("UPDATE account_holder_periods SET from_date = '2025-03-01' WHERE user_id = ? AND account_id = ?").run(bob.id, acc.a);
    const whole = await registerView(getDb(), bob.id, acc.a);
    expect(whole.rows.length).toBeGreaterThan(0);
    expect(whole.rows.every((r) => r.date >= '2025-03-01')).toBe(true);
    expect(whole.total).toBe(whole.rows.length);
    for (const limit of [1, 4]) expect(await registerPages(bob, acc.a, limit)).toEqual(whole.rows);
  });

  it('the page load sends one page and the count; a link to a row loads down to it; the endpoint guards', async () => {
    const whole = await registerView(getDb(), alice.id, acc.a);
    const ev = (query = '') => ({ locals: { user: alice }, params: { id: acc.a }, url: new URL(`http://localhost/accounts/${acc.a}${query}`) }) as never;
    const page = (await registerLoad(ev())) as { view: { rows: Row[]; total: number; next: string | null } };
    expect(page.view.rows).toEqual(whole.rows.slice(-Math.min(FIRST_PAGE, whole.rows.length)));
    expect(page.view.total).toBe(whole.rows.length);
    const oldRow = whole.rows[2]!;
    const linked = (await registerLoad(ev(`?tx=${oldRow.id}`))) as { view: { rows: Row[] } };
    expect(linked.view.rows.some((r) => r.id === oldRow.id)).toBe(true);

    const call = (user: AuthedUser | null, id: string, query: string) =>
      registerRows({ locals: { user }, params: { id }, url: new URL(`http://localhost/accounts/${id}/rows?${query}`) } as never);
    const cursor = registerCursorText(whole.rows[5]!);
    const body = (await (await call(alice, acc.a, `before=${encodeURIComponent(cursor)}`)).json()) as { rows: Row[]; next: string | null };
    expect(body.rows).toEqual(whole.rows.slice(0, 5));
    expect(body.next).toBeNull();
    // Bob holds A, never B: B is "not found", as a bogus id.
    await expect(call(bob, acc.b, `before=${encodeURIComponent(cursor)}`)).rejects.toMatchObject({ status: 404 });
    await expect(call(bob, randomUUID(), `before=${encodeURIComponent(cursor)}`)).rejects.toMatchObject({ status: 404 });
    await expect(call(alice, acc.a, 'before=junk')).rejects.toMatchObject({ status: 400 });
    await expect(call(null, acc.a, `before=${encodeURIComponent(cursor)}`)).rejects.toMatchObject({ status: 401 });
  });
});

describe('the Inbox by pages', () => {
  it('pages end to end are the whole Inbox, newest first; the counts are the whole list’s', async () => {
    const whole = await inboxTransactions(getDb(), alice.id);
    expect(whole.length).toBeGreaterThan(60);
    const dates = whole.map((r) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
    for (const limit of [1, 9, 40]) {
      const out: typeof whole = [];
      let after: InboxCursor | null = null;
      for (let i = 0; i < 1000; i++) {
        const page: Awaited<ReturnType<typeof inboxPage>> = await inboxPage(getDb(), alice.id, { limit, after });
        out.push(...page.rows);
        if (!page.next) break;
        after = parseCursor(cursorText(page.next));
      }
      expect(out).toEqual(whole);
    }
    const summary = await inboxSummary(getDb(), alice.id);
    expect(summary.total).toBe(whole.length);
    expect(summary.suggested).toBe(whole.filter((r) => r.suggestedCategoryId).length);
  });

  it('the page load sends one page with the counts; the endpoint guards', async () => {
    const whole = await inboxTransactions(getDb(), alice.id);
    const page = (await inboxLoad({ locals: { user: alice }, url: new URL('http://localhost/inbox?n=10') } as never)) as { rows: typeof whole; next: string | null; total: number };
    expect(page.rows).toEqual(whole.slice(0, 10));
    expect(page.total).toBe(whole.length);
    const call = (user: AuthedUser | null, query: string) => inboxRows({ locals: { user }, url: new URL(`http://localhost/inbox/rows?${query}`) } as never);
    const body = (await (await call(alice, `after=${encodeURIComponent(page.next!)}&limit=5`)).json()) as { rows: typeof whole };
    expect(body.rows).toEqual(whole.slice(10, 15));
    // Bob's Inbox holds only rows he holds (his own, and Alice's HDFC from the day he was given it).
    const bobs = (await (await call(bob, `after=${encodeURIComponent('2999-01-01|0|z')}&limit=2000`)).json()) as { rows: typeof whole };
    expect(bobs.rows.every((r) => r.accountId === acc.bobs || (r.accountId === acc.a && r.date >= '2025-03-01'))).toBe(true);
    await expect(call(null, `after=${encodeURIComponent(page.next!)}`)).rejects.toMatchObject({ status: 401 });
    await expect(call(alice, 'after=junk')).rejects.toMatchObject({ status: 400 });
  });
});
