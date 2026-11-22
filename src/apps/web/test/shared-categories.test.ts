/**
 * shared-categories.test.ts: categories are one list for the group, but a member can't delete
 * one, or change its group's kind, when rows they can't see are under it (F2). Rename, hide and move stay open to every member. Drives the real
 * route actions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { formatDate, today } from '@miserly/core';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-shared-categories-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin, createMember } from '../src/lib/server/auth/users';
import { createAccount } from '../src/lib/server/accounts';
import { createTransaction } from '../src/lib/server/transactions';
import { shareAccount } from '../src/lib/server/sharing';
import { createCategory, createGroup } from '../src/lib/server/categories';
import { appClock } from '../src/lib/server/clock';
import { actions } from '../src/routes/categories/+page.server';

const REFUSED = "Other members have rows in this category, so it can't be deleted. You can hide it.";
const PAST = '2025-06-01';

let alice: AuthedUser;
let bob: AuthedUser;
let aliceBank: string;
let jointBank: string;
let bobBank: string;
let todayIso: string;

function ev(user: AuthedUser, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return { locals: { user }, request: new Request('http://localhost/categories', { method: 'POST', body }) } as never;
}
type Result = { status?: number; data?: { message?: string }; ok?: boolean };
const act = async (name: keyof typeof actions, user: AuthedUser, fields: Record<string, string>) =>
  (await actions[name]!(ev(user, fields))) as Result;

const groupNamed = async (name: string, kind: 'spending' | 'investments' = 'spending') =>
  (await createGroup(getDb().db, { name, kind })).id;
const categoryIn = async (groupId: string, name: string) => (await createCategory(getDb().db, { groupId, name })).id;
const categoryOf = (txId: string) =>
  getDb().db.select({ c: schema.transactions.categoryId }).from(schema.transactions).where(eq(schema.transactions.id, txId)).get()!.c;
const kindOfGroup = (id: string) =>
  getDb().db.select({ k: schema.categoryGroups.kind }).from(schema.categoryGroups).where(eq(schema.categoryGroups.id, id)).get()!.k;

beforeAll(async () => {
  const db = getDb();
  alice = await createAdmin(db.db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  bob = await createMember(db.db, { username: 'bob', displayName: 'Bob', tempPassword: 'bob-password-123' });
  todayIso = formatDate(today(appClock()));
  const open = (ownerId: string, name: string) =>
    createAccount(db, { ownerId, type: 'bank', name, currency: 'INR', openingPaise: 1_00_000_00, openingDate: '2025-01-01' });
  aliceBank = (await open(alice.id, 'Alice private')).id;
  jointBank = (await open(alice.id, 'Joint')).id;
  bobBank = (await open(bob.id, 'Bob own')).id;
  await shareAccount(db.db, { userId: alice.id }, jointBank, bob.id); // Bob holds it from today
});

afterAll(() => {
  getDb().sqlite.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});

describe('S5: deleting a shared category', () => {
  it("is refused when a row under it is in an account the member doesn't hold; nothing moves", async () => {
    const g = await groupNamed('Health S5a');
    const medical = await categoryIn(g, 'Medical');
    const eatingOut = await categoryIn(g, 'Eating out');
    const tx = await createTransaction(getDb(), { userId: alice.id }, { accountId: aliceBank, date: PAST, amountPaise: -500_00, categoryId: medical });
    const r = await act('deleteCategory', bob, { id: medical, reassignToId: eatingOut });
    expect(r.status).toBe(400);
    expect(r.data?.message).toBe(REFUSED);
    expect(categoryOf(tx.id)).toBe(medical);
  });

  it("is refused when the row is in a shared account on a date before the member joined", async () => {
    const g = await groupNamed('Health S5b');
    const medical = await categoryIn(g, 'Medical');
    await createTransaction(getDb(), { userId: alice.id }, { accountId: jointBank, date: PAST, amountPaise: -500_00, categoryId: medical });
    const r = await act('deleteCategory', bob, { id: medical, reassignToId: '' });
    expect(r.data?.message).toBe(REFUSED);
  });

  it('with no reassign target, the answer about hidden rows is the same refusal, not "choose where"', async () => {
    const g = await groupNamed('Health S5c');
    const medical = await categoryIn(g, 'Medical');
    await createTransaction(getDb(), { userId: alice.id }, { accountId: aliceBank, date: PAST, amountPaise: -500_00, categoryId: medical });
    expect((await act('deleteCategory', bob, { id: medical })).data?.message).toBe(REFUSED);
  });

  it('goes ahead when every row under it is one the member can see (their own, and the joint from today)', async () => {
    const g = await groupNamed('Health S5d');
    const medical = await categoryIn(g, 'Medical');
    const eatingOut = await categoryIn(g, 'Eating out');
    const own = await createTransaction(getDb(), { userId: bob.id }, { accountId: bobBank, date: PAST, amountPaise: -100_00, categoryId: medical });
    const joint = await createTransaction(getDb(), { userId: bob.id }, { accountId: jointBank, date: todayIso, amountPaise: -100_00, categoryId: medical });
    expect((await act('deleteCategory', bob, { id: medical, reassignToId: eatingOut })).ok).toBe(true);
    expect(categoryOf(own.id)).toBe(eatingOut);
    expect(categoryOf(joint.id)).toBe(eatingOut);
  });

  it('the owner of every row deletes as before', async () => {
    const g = await groupNamed('Health S5e');
    const medical = await categoryIn(g, 'Medical');
    await createTransaction(getDb(), { userId: alice.id }, { accountId: aliceBank, date: PAST, amountPaise: -500_00, categoryId: medical });
    expect((await act('deleteCategory', alice, { id: medical, reassignToId: '' })).ok).toBe(true);
  });

  it('rename and hide stay open to every member', async () => {
    const g = await groupNamed('Health S5f');
    const medical = await categoryIn(g, 'Medical');
    await createTransaction(getDb(), { userId: alice.id }, { accountId: aliceBank, date: PAST, amountPaise: -500_00, categoryId: medical });
    expect((await act('renameCategory', bob, { id: medical, name: 'Doctor' })).status).toBeUndefined();
    expect((await act('hideCategory', bob, { id: medical })).ok).toBe(true);
  });
});

describe("S5: a group's delete and kind", () => {
  it("deleteGroup is refused when a hidden category in it has rows the member can't see", async () => {
    const g = await groupNamed('Old S5g');
    const c = await categoryIn(g, 'Old');
    await createTransaction(getDb(), { userId: alice.id }, { accountId: aliceBank, date: PAST, amountPaise: -500_00, categoryId: c });
    await act('hideCategory', alice, { id: c });
    expect((await act('deleteGroup', bob, { id: g })).data?.message).toBe(
      "Other members have rows in this group, so it can't be deleted. You can hide it.",
    );
  });

  it("setGroupKind is refused when rows the member can't see are under the group; the kind stays", async () => {
    const g = await groupNamed('Investing S5h', 'investments');
    const sip = await categoryIn(g, 'SIP');
    await createTransaction(getDb(), { userId: alice.id }, { accountId: aliceBank, date: PAST, amountPaise: -500_00, categoryId: sip });
    const r = await act('setGroupKind', bob, { id: g, kind: 'neutral' });
    expect(r.data?.message).toBe("Other members have rows in this group, so its kind can't be changed.");
    expect(kindOfGroup(g)).toBe('investments');
    expect((await act('setGroupKind', alice, { id: g, kind: 'neutral' })).ok).toBe(true);
  });
});
