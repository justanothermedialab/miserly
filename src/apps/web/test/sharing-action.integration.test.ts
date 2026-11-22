/**
 * sharing-action.integration.test.ts — the H2 shareMember/unshareMember ACTIONS,
 * end to end.
 * ============================================================================
 * The sharing SERVICE (owner-only gate, tombstone semantics, no-existence-leak)
 * is unit-tested in sharing.test.ts; this drives the actual route actions
 * (`routes/accounts/[id]/+page.server.ts` → shareMember/unshareMember) against a
 * real seeded DB — proving the form-field mapping and error→fail() status codes
 * without a browser (which OOMs here). `MISERLY_DB_PATH` points the singleton at
 * a throwaway file, matching the other *-action.integration.test.ts files.
 * ============================================================================
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-sharing-action-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin, createMember } from '../src/lib/server/auth/users';
import { isAccountVisibleTo } from '../src/lib/server/visibility';
import { actions } from '../src/routes/accounts/[id]/+page.server';

let alice: AuthedUser; // owner (also happens to be admin — irrelevant to H2 ownership)
let bob: AuthedUser; // a Circle member, not the owner
let carol: AuthedUser; // another Circle member — the share target
let acctId: string;

/** A RequestEvent-shaped arg carrying a real form-encoded Request. */
function ev(user: AuthedUser, accountId: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request('http://localhost/', { method: 'POST', body });
  return { locals: { user }, params: { id: accountId }, request } as never;
}

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  bob = await createMember(db, { username: 'bob', displayName: 'Bob', tempPassword: 'bob-temp-pass-123' });
  carol = await createMember(db, { username: 'carol', displayName: 'Carol', tempPassword: 'carol-temp-pass-123' });
  acctId = randomUUID();
  db.insert(schema.accounts)
    .values({ id: acctId, ownerId: alice.id, name: 'Joint Pool', type: 'bank', currency: 'INR', openingPaise: 0 })
    .run();
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('shareMember action', () => {
  it('the owner shares via the action → the target gains visibility of the account', async () => {
    expect(await isAccountVisibleTo(getDb().db, bob.id, acctId)).toBe(false);

    const share = actions.shareMember as (arg: never) => Promise<unknown>;
    const result = (await share(ev(alice, acctId, { targetUserId: bob.id }))) as { shared?: boolean };
    expect(result.shared).toBe(true);

    expect(await isAccountVisibleTo(getDb().db, bob.id, acctId)).toBe(true);
  });

  it('a NON-owner (a member who can now see the account) calling shareMember gets a 403', async () => {
    // Bob was shared into the account above — he can SEE it but does not OWN it.
    const share = actions.shareMember as (arg: never) => Promise<unknown>;
    const result = (await share(ev(bob, acctId, { targetUserId: carol.id }))) as { status?: number };
    expect(result.status).toBe(403);
    // Carol was never granted access by the rejected call.
    expect(await isAccountVisibleTo(getDb().db, carol.id, acctId)).toBe(false);
  });

  it('a caller who cannot see the account at all gets a 404 (no existence leak)', async () => {
    const share = actions.shareMember as (arg: never) => Promise<unknown>;
    const result = (await share(ev(carol, acctId, { targetUserId: bob.id }))) as { status?: number };
    expect(result.status).toBe(404);
  });

  it('a blank targetUserId is a 400 (field validation, before the service is called)', async () => {
    const share = actions.shareMember as (arg: never) => Promise<unknown>;
    const result = (await share(ev(alice, acctId, { targetUserId: '' }))) as { status?: number };
    expect(result.status).toBe(400);
  });
});

describe('unshareMember action', () => {
  it('the owner unshares via the action → the member loses visibility immediately', async () => {
    expect(await isAccountVisibleTo(getDb().db, bob.id, acctId)).toBe(true);

    const unshare = actions.unshareMember as (arg: never) => Promise<unknown>;
    const result = (await unshare(ev(alice, acctId, { targetUserId: bob.id }))) as { unshared?: boolean };
    expect(result.unshared).toBe(true);

    expect(await isAccountVisibleTo(getDb().db, bob.id, acctId)).toBe(false);
  });

  it('a non-owner cannot unshare (403)', async () => {
    // Re-share bob so there is something to (attempt to) revoke.
    const share = actions.shareMember as (arg: never) => Promise<unknown>;
    await share(ev(alice, acctId, { targetUserId: bob.id }));

    const unshare = actions.unshareMember as (arg: never) => Promise<unknown>;
    const result = (await unshare(ev(bob, acctId, { targetUserId: bob.id }))) as { status?: number };
    expect(result.status).toBe(403);
    // Bob's own access is untouched by his own rejected attempt.
    expect(await isAccountVisibleTo(getDb().db, bob.id, acctId)).toBe(true);
  });
});
