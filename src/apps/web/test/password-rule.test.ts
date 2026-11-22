/**
 * password-rule.test.ts: a password set or changed (setup, add member, reset, change password) is
 * at least 10 characters, is not the username, and is not one of the most common passwords
 * (H1). Existing passwords keep working.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRedirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-password-rule-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createMember, verifyCredentials } from '../src/lib/server/auth/users';
import { actions as setupActions } from '../src/routes/setup/+page.server';
import { actions as settingsActions } from '../src/routes/settings/+page.server';
import { actions as changeActions } from '../src/routes/change-password/+page.server';

function ev(user: AuthedUser | null, url: string, fields: Record<string, string>) {
  return {
    locals: { user },
    url: new URL(url),
    cookies: { set: () => undefined, get: () => undefined },
    request: new Request(url, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
  } as never;
}
async function call(fn: (e: never) => unknown, e: never): Promise<{ status?: number; data?: Record<string, string>; redirected?: boolean }> {
  try {
    return (await fn(e)) as never;
  } catch (thrown) {
    if (isRedirect(thrown)) return { redirected: true };
    throw thrown;
  }
}

let alice: AuthedUser;

afterAll(() => {
  getDb().sqlite.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});

describe('S14: the setup form', () => {
  it.each([
    ['nine char', 'Use at least 10 characters.'],
    ['qwertyuiop', 'That password is one of the most common. Choose another.'],
    ['1234567890', 'That password is one of the most common. Choose another.'],
    ['Basketball', 'That password is one of the most common. Choose another.'],
  ])('refuses %j', async (password, message) => {
    const r = await call(setupActions.default!, ev(null, 'http://localhost/setup', { username: 'alice', password }));
    expect(r.status).toBe(400);
    expect(r.data?.message).toBe(message);
  });

  it('a username padded to 10 is still the username', async () => {
    const r = await call(setupActions.default!, ev(null, 'http://localhost/setup', { username: 'alicealice', password: 'AliceAlice' }));
    expect(r.data?.message).toBe("The password can't be your username.");
  });

  it('takes a 10-character password that is none of those', async () => {
    const r = await call(setupActions.default!, ev(null, 'http://localhost/setup', { username: 'alice', password: 'tea at four' }));
    expect(r.redirected).toBe(true);
    alice = { ...(getDb().db.select().from(schema.users).where(eq(schema.users.username, 'alice')).get()!), role: 'admin' } as AuthedUser;
  });
});

describe('S14: add member, reset and change password', () => {
  beforeAll(async () => {
    await createMember(getDb().db, { username: 'oldbob', displayName: 'Bob', tempPassword: 'short-pw' });
  });

  it('add member refuses a common temporary password and the username', async () => {
    const common = await call(settingsActions.addMember!, ev(alice, 'http://localhost/settings', { username: 'carol', displayName: 'Carol', tempPassword: 'password123' }));
    expect(common.data?.memberError).toBe('That password is one of the most common. Choose another.');
    const same = await call(settingsActions.addMember!, ev(alice, 'http://localhost/settings', { username: 'carolcarol', displayName: 'Carol', tempPassword: 'carolcarol' }));
    expect(same.data?.memberError).toBe("The password can't be their username.");
  });

  it('reset refuses a 9-character temporary password', async () => {
    const bob = getDb().db.select().from(schema.users).where(eq(schema.users.username, 'oldbob')).get()!;
    const r = await call(settingsActions.resetPassword!, ev(alice, 'http://localhost/settings', { targetUserId: bob.id, tempPassword: 'nine-char' }));
    expect(r.data?.memberError).toBe('Use at least 10 characters.');
  });

  it('an existing 8-character password still signs in', async () => {
    expect(await verifyCredentials(getDb().db, 'oldbob', 'short-pw')).not.toBeNull();
  });

  it('change password refuses a common one', async () => {
    const bob = getDb().db.select().from(schema.users).where(eq(schema.users.username, 'oldbob')).get()!;
    const user = { id: bob.id, username: 'oldbob', role: 'member' as const };
    const r = await call(changeActions.default!, ev(user, 'http://localhost/change-password', { newPassword: 'iloveyou12', confirmPassword: 'iloveyou12' }));
    expect(r.data?.message).toBe('That password is one of the most common. Choose another.');
  });
});
