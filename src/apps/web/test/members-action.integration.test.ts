/**
 * members-action.integration.test.ts — the H3 addMember/resetPassword/removeMember
 * settings ACTIONS, end to end.
 * ============================================================================
 * The members SERVICE (admin-only gate, last-admin rule, shared-ownership block,
 * atomic revoke) is unit-tested in members.test.ts; this drives the actual route
 * actions (`routes/settings/+page.server.ts`) against a real seeded DB — proving
 * the route-level admin gate, form-field mapping, and error→fail() status/body
 * shape (including the blocked-removal `blockedAccounts` payload the UI names)
 * without a browser (which OOMs here). `MISERLY_DB_PATH` points the singleton at
 * a throwaway file, matching the other *-action.integration.test.ts files.
 * ============================================================================
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-members-action-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin, createMember } from '../src/lib/server/auth/users';
import { actions } from '../src/routes/settings/+page.server';

let alice: AuthedUser; // admin
let bob: AuthedUser; // plain member — removable
let carol: AuthedUser; // owns a shared account — removal should be blocked

/** A RequestEvent-shaped arg carrying a real form-encoded Request (no route params
 *  needed — every settings action reads the actor from `locals` and the target
 *  from the form body). */
function ev(user: AuthedUser | null, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request('http://localhost/', { method: 'POST', body });
  return { locals: { user }, request } as never;
}

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  bob = await createMember(db, { username: 'bob', displayName: 'Bob', tempPassword: 'bob-temp-pass-123' });
  carol = await createMember(db, { username: 'carol', displayName: 'Carol', tempPassword: 'carol-temp-pass-123' });

  const sharedAcctId = randomUUID();
  db.insert(schema.accounts)
    .values({ id: sharedAcctId, ownerId: carol.id, name: 'Carol pool', type: 'bank', currency: 'INR', openingPaise: 0 })
    .run();
  // Bob is a co-holder of Carol's account — this is what blocks CAROL's removal
  // (she solely owns a shared account), not Bob's.
  db.insert(schema.accountMembers).values({ accountId: sharedAcctId, userId: bob.id }).run();
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

function liveUser(id: string) {
  return getDb()
    .db.select()
    .from(schema.users)
    .where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt)))
    .get();
}

describe('addMember action', () => {
  it('admin adds a member via the action', async () => {
    const add = actions.addMember as (arg: never) => Promise<unknown>;
    const result = (await add(
      ev({ id: alice.id, username: alice.username, role: 'admin' }, {
        username: 'dave',
        displayName: 'Dave',
        tempPassword: 'dave-temp-pass-123',
      }),
    )) as { memberAdded?: boolean };
    expect(result.memberAdded).toBe(true);

    const row = getDb().db.select().from(schema.users).where(eq(schema.users.username, 'dave')).get();
    expect(row?.role).toBe('member');
    expect(row?.mustChangePassword).toBe(true);
  });

  it('a NON-admin calling addMember gets a 403 (no row written)', async () => {
    const add = actions.addMember as (arg: never) => Promise<unknown>;
    const result = (await add(
      ev({ id: bob.id, username: bob.username, role: 'member' }, {
        username: 'eve',
        displayName: 'Eve',
        tempPassword: 'eve-temp-pass-123',
      }),
    )) as { status?: number };
    expect(result.status).toBe(403);
    expect(getDb().db.select().from(schema.users).where(eq(schema.users.username, 'eve')).get()).toBeUndefined();
  });

  it('a too-short temp password is a 400 (field validation, before the service is called)', async () => {
    const add = actions.addMember as (arg: never) => Promise<unknown>;
    const result = (await add(
      ev({ id: alice.id, username: alice.username, role: 'admin' }, {
        username: 'frank',
        displayName: 'Frank',
        tempPassword: 'short',
      }),
    )) as { status?: number };
    expect(result.status).toBe(400);
  });
});

describe('removeMember action', () => {
  it('a NON-admin calling removeMember gets a 403', async () => {
    const remove = actions.removeMember as (arg: never) => Promise<unknown>;
    const result = (await remove(
      ev({ id: bob.id, username: bob.username, role: 'member' }, { targetUserId: carol.id }),
    )) as { status?: number };
    expect(result.status).toBe(403);
    expect(liveUser(carol.id)).toBeDefined(); // untouched
  });

  it('removal blocked by shared ownership surfaces the blocking accounts (409)', async () => {
    const remove = actions.removeMember as (arg: never) => Promise<unknown>;
    const result = (await remove(
      ev({ id: alice.id, username: alice.username, role: 'admin' }, { targetUserId: carol.id }),
    )) as { status?: number; data?: { blockedAccounts?: { id: string; name: string }[] } };
    expect(result.status).toBe(409);
    expect(result.data?.blockedAccounts?.some((a) => a.name === 'Carol pool')).toBe(true);
    // Carol was NOT removed — nothing mutated by the blocked attempt.
    expect(liveUser(carol.id)).toBeDefined();
  });

  it('admin removes a member with no blocking shared accounts (success)', async () => {
    const remove = actions.removeMember as (arg: never) => Promise<unknown>;
    const result = (await remove(
      ev({ id: alice.id, username: alice.username, role: 'admin' }, { targetUserId: bob.id }),
    )) as { memberRemoved?: boolean };
    expect(result.memberRemoved).toBe(true);
    expect(liveUser(bob.id)).toBeUndefined(); // soft-deleted → no longer "live"
  });

  it('the admin can never remove themself (last-admin rule) — 400', async () => {
    const remove = actions.removeMember as (arg: never) => Promise<unknown>;
    const result = (await remove(
      ev({ id: alice.id, username: alice.username, role: 'admin' }, { targetUserId: alice.id }),
    )) as { status?: number };
    expect(result.status).toBe(400);
  });
});
