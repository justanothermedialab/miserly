/**
 * name-check-privacy.integration.test.ts: a P0 privacy case. A member who holds a shared account
 * learned the names of the owner's PRIVATE accounts: renaming the shared one (Edit account) to a name
 * the owner uses on a private open account of the same type answered "An open account with that
 * name already exists". Reopen had the same check. The check now counts only the accounts the person
 * acting can see; the owner's own rule (no two of their open accounts of a type share a name) holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-name-privacy-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin, createMember } from '../src/lib/server/auth/users';
import { shareAccount } from '../src/lib/server/sharing';
import { actions } from '../src/routes/accounts/[id]/+page.server';
import { eq } from 'drizzle-orm';

let alice: AuthedUser; // the owner
let bob: AuthedUser; // holds "HDFC" only
let sharedId: string;
let secretId: string;
let closedSharedId: string;

function ev(user: AuthedUser, id: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return { locals: { user }, params: { id }, request: new Request('http://localhost/', { method: 'POST', body }) } as never;
}
const run = (fn: unknown, arg: never) =>
  (fn as (a: never) => Promise<unknown>)(arg) as Promise<{ status?: number; data?: { errors?: Record<string, string> } } & Record<string, unknown>>;
const nameOf = (id: string) => getDb().db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get()!.name;

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  bob = await createMember(db, { username: 'bob', displayName: 'Bob', tempPassword: 'bob-temp-pass-123' });
  sharedId = randomUUID();
  secretId = randomUUID();
  closedSharedId = randomUUID();
  db.insert(schema.accounts)
    .values([
      { id: sharedId, ownerId: alice.id, name: 'HDFC', type: 'bank', currency: 'INR', openingPaise: 0 },
      { id: secretId, ownerId: alice.id, name: 'Secret FD', type: 'bank', currency: 'INR', openingPaise: 0 },
      { id: closedSharedId, ownerId: alice.id, name: 'Old savings', type: 'bank', currency: 'INR', openingPaise: 0, status: 'closed' },
    ])
    .run();
  await shareAccount(db, { userId: alice.id }, sharedId, bob.id);
  await shareAccount(db, { userId: alice.id }, closedSharedId, bob.id);
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('the name check stays inside what the actor sees', () => {
  it("a holder renaming the shared account to the owner's private name gets no clash", async () => {
    const res = await run(actions.editAccount, ev(bob, sharedId, { name: 'secret fd', opening: '0' }));
    expect(res).toEqual({ accountSaved: true });
    expect(nameOf(sharedId)).toBe('secret fd');
    // Put it back for the next tests.
    expect(await run(actions.editAccount, ev(bob, sharedId, { name: 'HDFC', opening: '0' }))).toEqual({ accountSaved: true });
  });

  it('the answer is the same for a name that exists privately and one that exists nowhere', async () => {
    const taken = await run(actions.editAccount, ev(bob, sharedId, { name: 'Secret FD', opening: '0' }));
    await run(actions.editAccount, ev(bob, sharedId, { name: 'HDFC', opening: '0' }));
    const free = await run(actions.editAccount, ev(bob, sharedId, { name: 'Nothing like it', opening: '0' }));
    await run(actions.editAccount, ev(bob, sharedId, { name: 'HDFC', opening: '0' }));
    expect(taken).toEqual(free);
  });

  it('a holder reopening a shared account named like a private open one gets no clash', async () => {
    getDb().db.update(schema.accounts).set({ name: 'Secret FD' }).where(eq(schema.accounts.id, closedSharedId)).run();
    const res = await run(actions.reopen, ev(bob, closedSharedId, {}));
    expect(res).toEqual({ reopened: true });
  });

  it("the owner still can't give two of their open accounts of one type the same name", async () => {
    const res = await run(actions.editAccount, ev(alice, sharedId, { name: 'secret fd', opening: '0' }));
    expect(res.status).toBe(400);
    expect(res.data?.errors?.name).toBe('An open account with that name already exists');
  });
});
