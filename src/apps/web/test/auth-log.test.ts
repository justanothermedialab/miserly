/**
 * auth-log.test.ts: failed sign-ins, locks, resets and members added or removed each leave one
 * log line with the time, the username and the address, never the password; the failure map is
 * capped. Drives the real sign-in and settings actions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-auth-log-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin, resetFailures, takeAttempt, trackedFailureCount } from '../src/lib/server/auth/users';
import { LOCKOUT } from '../src/lib/server/config';
import { actions as signinActions } from '../src/routes/signin/+page.server';
import { actions as settingsActions } from '../src/routes/settings/+page.server';

let alice: AuthedUser;
let lines: string[] = [];

beforeAll(async () => {
  alice = await createAdmin(getDb().db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
});
afterAll(() => {
  getDb().sqlite.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});
afterEach(() => vi.restoreAllMocks());

function capture() {
  lines = [];
  const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'info').mockImplementation(keep);
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
}

function form(url: string, fields: Record<string, string>, user: AuthedUser | null = null) {
  return {
    request: new Request(url, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    url: new URL(url),
    cookies: { set: () => undefined },
    locals: { user },
    getClientAddress: () => '192.168.1.77',
  } as never;
}

async function signIn(username: string, password: string) {
  try {
    return await signinActions.default!(form('http://localhost/signin', { username, password }));
  } catch (thrown) {
    return thrown;
  }
}

describe('S13: what the server logs', () => {
  it('a failed sign-in: one line with time, username and address, no password', async () => {
    capture();
    await signIn('alice', 'Wrong-Secret-42');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u);
    expect(lines[0]).toContain('alice');
    expect(lines[0]).toContain('192.168.1.77');
    expect(lines[0]).not.toContain('Wrong-Secret-42');
    resetFailures('alice');
  });

  it('a lock: one line when the last allowed try fails, none for the tries refused after', async () => {
    for (let i = 0; i < LOCKOUT.maxAttempts - 1; i++) await signIn('alice', `wrong-${i}`);
    capture();
    await signIn('alice', 'wrong-last');
    await signIn('alice', 'wrong-refused');
    expect(lines.filter((l) => /lock/iu.test(l))).toHaveLength(1);
    resetFailures('alice');
  });

  it('a username cannot forge a second line', async () => {
    capture();
    await signIn('mallory\n2026-01-01T00:00:00Z sign-in ok', 'x');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
  });

  it('a member added, a password reset and a member removed: one line each, naming the member and the admin', async () => {
    capture();
    const add = form('http://localhost/settings', { username: 'dev', displayName: 'Dev', tempPassword: 'dev-temporary-1' }, alice);
    expect(await settingsActions.addMember!(add)).toEqual({ memberAdded: true });
    const dev = getDb().db.select().from(schema.users).where(and(eq(schema.users.username, 'dev'), isNull(schema.users.deletedAt))).get()!;
    await settingsActions.resetPassword!(form('http://localhost/settings', { targetUserId: dev.id, tempPassword: 'dev-temporary-2' }, alice));
    await settingsActions.removeMember!(form('http://localhost/settings', { targetUserId: dev.id }, alice));
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l).toContain('"dev"');
      expect(l).toContain('"alice"');
      expect(l).toContain('192.168.1.77');
      expect(l).not.toContain('dev-temporary');
    }
  });

  it('the failure map stays capped however many usernames are tried', () => {
    for (let i = 0; i < 10_050; i++) takeAttempt(`spray-${i}`);
    expect(trackedFailureCount()).toBeLessThanOrEqual(10_000);
  });
});
