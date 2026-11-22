/**
 * c4c5-action.integration.test.ts — the C4 register edit/delete/restore actions
 * and the C5 inbox categorize action, driven end to end (browser OOMs here).
 * ============================================================================
 * The service layer is unit-tested in c4-edit/inbox; this proves the route
 * actions parse the form, pass the optimistic token, and surface the right
 * outcomes. `MISERLY_DB_PATH` points the singleton at a throwaway file.
 * ============================================================================
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-c4c5-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { accountBalance } from '../src/lib/server/db/balances';
import { createTransaction, inboxTransactions } from '../src/lib/server/transactions';
import { actions as registerActions } from '../src/routes/accounts/[id]/+page.server';
import { actions as inboxActions } from '../src/routes/inbox/+page.server';

let alice: AuthedUser;
let acct: string;
let catId: string;

function user(): AuthedUser {
  return { id: alice.id, username: 'alice', role: 'admin' };
}
function ev(fields: Record<string, string>, id?: string) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request('http://localhost/', { method: 'POST', body });
  return { locals: { user: user() }, params: id ? { id } : {}, request } as never;
}

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  acct = randomUUID();
  catId = randomUUID();
  db.insert(schema.accounts).values({ id: acct, ownerId: alice.id, name: 'HDFC', type: 'bank', currency: 'INR', openingPaise: 1000_00, openingDate: '2024-01-01' }).run();
  db.insert(schema.categoryGroups).values({ id: 'g1', name: 'Living', kind: 'spending' }).run();
  db.insert(schema.categories).values({ id: catId, groupId: 'g1', name: 'Groceries' }).run();
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('C4 register edit action', () => {
  it('edits an amount via the form and recomputes the balance', async () => {
    const tx = await createTransaction(getDb(), { userId: alice.id }, { accountId: acct, date: '2024-02-01', amountPaise: -100_00 });
    const edit = registerActions.editTx as (arg: never) => Promise<unknown>;
    const r = (await edit(ev({ txId: tx.id, expectedUpdatedAt: tx.updatedAt, date: '2024-02-01', outflow: '250' }))) as { edited?: boolean };
    expect(r.edited).toBe(true);
    expect(accountBalance(getDb().sqlite, acct)).toBe(750_00);
  });

  it('rejects a STALE edit with a 409', async () => {
    const tx = await createTransaction(getDb(), { userId: alice.id }, { accountId: acct, date: '2024-03-01', amountPaise: -10_00 });
    const edit = registerActions.editTx as (arg: never) => Promise<unknown>;
    const r = (await edit(ev({ txId: tx.id, expectedUpdatedAt: 'stale', date: '2024-03-01', outflow: '99' }))) as { status?: number };
    expect(r.status).toBe(409);
  });

  it('deletes then restores a row (balance round-trips)', async () => {
    const tx = await createTransaction(getDb(), { userId: alice.id }, { accountId: acct, date: '2024-04-01', amountPaise: -60_00 });
    const before = accountBalance(getDb().sqlite, acct);
    const del = registerActions.deleteTx as (arg: never) => Promise<unknown>;
    const dr = (await del(ev({ txId: tx.id, expectedUpdatedAt: tx.updatedAt }))) as { deleted?: boolean };
    expect(dr.deleted).toBe(true);
    expect(accountBalance(getDb().sqlite, acct)).toBe(before + 60_00);
    const restore = registerActions.restoreTx as (arg: never) => Promise<unknown>;
    await restore(ev({ txId: tx.id }));
    expect(accountBalance(getDb().sqlite, acct)).toBe(before);
  });
});

describe('C4 bulk delete + undo actions (REL-03)', () => {
  function multi(fields: [string, string][]) {
    const body = new FormData();
    for (const [k, v] of fields) body.append(k, v);
    const request = new Request('http://localhost/', { method: 'POST', body });
    return { locals: { user: user() }, params: {}, request } as never;
  }

  it('bulk delete returns the deleted ids; restoreBulkTx brings them all back', async () => {
    const a = await createTransaction(getDb(), { userId: alice.id }, { accountId: acct, date: '2024-06-01', amountPaise: -11_00 });
    const b = await createTransaction(getDb(), { userId: alice.id }, { accountId: acct, date: '2024-06-02', amountPaise: -22_00 });
    const before = accountBalance(getDb().sqlite, acct);
    const bulk = registerActions.bulkTx as (arg: never) => Promise<unknown>;
    const r = (await bulk(multi([['op', 'delete'], ['ids', a.id], ['ids', b.id]]))) as { op?: string; deletedIds?: string[] };
    expect(r.op).toBe('delete');
    expect(new Set(r.deletedIds)).toEqual(new Set([a.id, b.id]));
    expect(accountBalance(getDb().sqlite, acct)).toBe(before + 33_00);

    const undo = registerActions.restoreBulkTx as (arg: never) => Promise<unknown>;
    const u = (await undo(multi(r.deletedIds!.map((id) => ['ids', id] as [string, string])))) as { restoredCount?: number };
    expect(u.restoredCount).toBe(2);
    expect(accountBalance(getDb().sqlite, acct)).toBe(before);
  });
});

describe('C5 inbox categorize action', () => {
  it('categorizing removes a row from the inbox', async () => {
    const tx = await createTransaction(getDb(), { userId: alice.id }, { accountId: acct, date: '2024-05-01', amountPaise: -30_00 });
    expect((await inboxTransactions(getDb(), alice.id)).some((r) => r.id === tx.id)).toBe(true);
    const categorize = inboxActions.categorize as (arg: never) => Promise<unknown>;
    const r = (await categorize(ev({ ids: tx.id, categoryId: catId }))) as { categorized?: boolean };
    expect(r.categorized).toBe(true);
    expect((await inboxTransactions(getDb(), alice.id)).some((r2) => r2.id === tx.id)).toBe(false);
    const row = getDb().db.select().from(schema.transactions).where(eq(schema.transactions.id, tx.id)).get()!;
    expect(row.categoryId).toBe(catId);
  });

  it('Undo puts the row back in the inbox (UX-REVIEW P12)', async () => {
    const tx = await createTransaction(getDb(), { userId: alice.id }, { accountId: acct, date: '2024-05-02', amountPaise: -40_00 });
    const categorize = inboxActions.categorize as (arg: never) => Promise<unknown>;
    const r = (await categorize(ev({ ids: tx.id, categoryId: catId }))) as { ids?: string[] };
    expect(r.ids).toEqual([tx.id]);
    const undo = inboxActions.uncategorize as (arg: never) => Promise<unknown>;
    const u = (await undo(ev({ ids: r.ids![0]! }))) as { restoredCount?: number };
    expect(u.restoredCount).toBe(1);
    expect((await inboxTransactions(getDb(), alice.id)).some((r2) => r2.id === tx.id)).toBe(true);
  });
});
