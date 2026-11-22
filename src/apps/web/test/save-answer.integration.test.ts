/**
 * save-answer.integration.test.ts: a save answers with what changed, not the page.
 * Every save used to reload the whole page (2.6 MB on All transactions at 5,000
 * rows). Now the register's saves answer with its figures and the rows from the date they touched
 * on, All transactions' with its own rows, and the page patches its list (`$lib/register/patch`).
 * Each case here holds the patched list to what a reload shows, field for field.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-save-answer-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { registerView, createTransaction } from '../src/lib/server/transactions';
import { recentActivity } from '../src/lib/server/dashboard';
import { postValuationMark } from '../src/lib/server/marks';
import { actions } from '../src/routes/accounts/[id]/+page.server';
import { load as layoutLoad } from '../src/routes/+layout.server';
import { withTail, withAnswer } from '../src/lib/register/patch';

let alice: AuthedUser;
let bankId: string;
let fundId: string;

type Answer = {
  status?: number;
  page?: { view: { rows: unknown[]; asOfTodayPaise: number; projectedPaise: number }; holding: unknown };
  tail?: { from: string; rows: Awaited<ReturnType<typeof registerView>>['rows'] };
  activity?: Awaited<ReturnType<typeof recentActivity>>;
};
function ev(id: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return { locals: { user: alice }, params: { id }, request: new Request('http://localhost/', { method: 'POST', body }) } as never;
}
const run = (fn: unknown, arg: never) => (fn as (a: never) => Promise<Answer>)(arg);
const register = async (id: string) => registerView(getDb(), alice.id, id);
const feed = () => recentActivity(getDb(), alice.id, 1000);
const rowOf = async (id: string, txId: string) => (await register(id)).rows.find((r) => r.id === txId)!;
/** The fields the grid posts for a row, with `change` applied. */
async function posted(accountId: string, txId: string, change: Record<string, string>) {
  const r = await rowOf(accountId, txId);
  return {
    txId: r.id, expectedUpdatedAt: r.updatedAt, date: r.date, payee: r.payeeName ?? '', category: r.categoryId ?? '',
    outflow: r.amountPaise < 0 ? (-r.amountPaise / 100).toFixed(2) : '', inflow: r.amountPaise > 0 ? (r.amountPaise / 100).toFixed(2) : '',
    notes: r.notes ?? '', ...change,
  };
}

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  bankId = randomUUID();
  fundId = randomUUID();
  db.insert(schema.accounts)
    .values([
      { id: bankId, ownerId: alice.id, name: 'HDFC', type: 'bank', currency: 'INR', openingPaise: 50_000_00, openingDate: '2024-01-01' },
      { id: fundId, ownerId: alice.id, name: 'Index fund', type: 'mutualFunds', currency: 'INR', openingPaise: 10_000_00, openingDate: '2024-01-01' },
    ])
    .run();
  for (let i = 0; i < 120; i++) {
    const date = `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`;
    await createTransaction(getDb(), { userId: alice.id }, { accountId: bankId, date, amountPaise: -(100_00 + i * 7), payeeName: `Shop ${i % 9}`, notes: i % 5 ? null : 'a note' });
  }
  for (const [date, target] of [['2025-02-01', 11_000_00], ['2025-06-01', 12_500_00], ['2025-10-01', 13_000_00]] as const) {
    await postValuationMark(getDb(), { userId: alice.id }, { accountId: fundId, targetPaise: target, date });
  }
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe("the register: a save's answer patches the list to what a reload shows", () => {
  it('an amount changed on an old row: the rows from its date on, balances and figures', async () => {
    const before = await register(bankId);
    const old = before.rows[10]!;
    const res = await run(actions.editTx, ev(bankId, await posted(bankId, old.id, { outflow: '999.50', field: 'outflow' })));
    const after = await register(bankId);
    expect(res.page!.view.rows).toEqual([]); // never the whole list
    expect(res.tail!.rows.length).toBe(after.rows.filter((r) => r.date >= old.date).length);
    expect(withTail(before.rows, res.tail!)).toEqual(after.rows);
    expect(res.page!.view.asOfTodayPaise).toBe(after.asOfTodayPaise);
  });

  it('a date moved earlier, and later', async () => {
    for (const [index, date] of [[90, '2025-01-02'], [5, '2025-12-30']] as const) {
      const before = await register(bankId);
      const row = before.rows[index]!;
      const res = await run(actions.editTx, ev(bankId, await posted(bankId, row.id, { date, field: 'date' })));
      expect(withTail(before.rows, res.tail!)).toEqual((await register(bankId)).rows);
    }
  });

  it('a row added (back-dated)', async () => {
    const before = await register(bankId);
    const res = await run(actions.addTransaction, ev(bankId, { date: '2025-03-15', payee: 'Shop 1', outflow: '12.34' }));
    expect(withTail(before.rows, res.tail!)).toEqual((await register(bankId)).rows);
  });

  it("a value update's value edited: the later ones follow", async () => {
    const before = await register(fundId);
    const mark = before.rows.find((r) => r.kind === 'valuationMark')!;
    const res = await run(actions.editMark, ev(fundId, { markId: mark.id, expectedUpdatedAt: mark.updatedAt, target: '11800', date: mark.date, notes: '' }));
    const after = await register(fundId);
    expect(withTail(before.rows, res.tail!)).toEqual(after.rows);
    expect(res.page!.holding).not.toBeNull(); // the holding header's figures come with it
  });

  it('the answer is small beside the list', async () => {
    const list = await register(bankId);
    const latest = list.rows.at(-1)!;
    const res = await run(actions.editTx, ev(bankId, await posted(bankId, latest.id, { notes: 'edited', field: 'notes' })));
    expect(res.tail!.rows.length).toBeLessThan(5);
    expect(JSON.stringify(res.tail).length * 10).toBeLessThan(JSON.stringify(list.rows).length);
  });
});

describe("All transactions: a save's answer in its own shape", () => {
  it('an edit and an add patch the list to what a reload shows', async () => {
    let before = await feed();
    const row = before.find((r) => r.accountId === bankId)!;
    let res = await run(actions.editTx, ev(bankId, { ...(await posted(bankId, row.id, { outflow: '77.70', field: 'outflow' })), view: 'all' }));
    expect(res.page).toBeUndefined();
    expect(withAnswer(before, res.activity!)).toEqual(await feed());

    before = await feed();
    res = await run(actions.addTransaction, ev(bankId, { date: '2026-01-05', payee: 'Shop 2', outflow: '5', view: 'all' }));
    expect(res.activity!.length).toBe(1);
    expect(withAnswer(before, res.activity!)).toEqual(await feed());
  });
});

describe('a save reloads the layout alone', () => {
  it("the layout depends on 'app:nav' (the sidebar, the Inbox count, Quick add's lists)", async () => {
    const keys: string[] = [];
    await (layoutLoad as (e: never) => Promise<unknown>)({
      locals: { user: alice }, request: new Request('http://localhost/'), cookies: { get: () => undefined }, depends: (...k: string[]) => keys.push(...k),
    } as never);
    expect(keys).toContain('app:nav');
  });
});
