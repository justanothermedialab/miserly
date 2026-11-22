/**
 * signin-throttle.test.ts: the sign-in lockout holds against tries sent together (security read
 * S1). The password check is replaced by a slow stand-in that counts its calls and how many run at
 * once, so the test measures the route's own throttle, not Argon2's speed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRedirect } from '@sveltejs/kit';

const DB_PATH = path.join(os.tmpdir(), `miserly-signin-throttle-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

const counter = vi.hoisted(() => ({ calls: 0, inFlight: 0, maxInFlight: 0, goodPassword: '' }));

vi.mock('../src/lib/server/auth/users', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/server/auth/users')>();
  return {
    ...real,
    verifyCredentials: async (_db: unknown, username: string, password: string) => {
      counter.calls += 1;
      counter.inFlight += 1;
      counter.maxInFlight = Math.max(counter.maxInFlight, counter.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      counter.inFlight -= 1;
      return password === counter.goodPassword
        ? { id: 'u-' + username, username, role: 'member' as const }
        : null;
    },
  };
});

vi.mock('../src/lib/server/auth/session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/server/auth/session')>();
  return { ...real, createSession: async () => ({ token: 'tok', sessionId: 's' }) };
});

import { getDb } from '../src/lib/server/db/instance';
import { actions } from '../src/routes/signin/+page.server';
import { resetFailures } from '../src/lib/server/auth/users';
import { LOCKOUT } from '../src/lib/server/config';

function signinEvent(username: string, password: string) {
  const body = new URLSearchParams({ username, password });
  return {
    request: new Request('http://localhost/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
    cookies: { set: () => undefined },
    url: new URL('http://localhost/signin'),
    getClientAddress: () => '10.0.0.9',
  } as never;
}

async function attempt(username: string, password: string): Promise<unknown> {
  try {
    return await actions.default!(signinEvent(username, password));
  } catch (thrown) {
    return thrown;
  }
}

beforeEach(() => {
  counter.calls = 0;
  counter.inFlight = 0;
  counter.maxInFlight = 0;
  counter.goodPassword = 'the-right-one';
});

afterAll(() => {
  getDb().sqlite.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});

describe('S1: the sign-in lockout against tries sent together', () => {
  it('50 wrong tries sent at once: no more than maxAttempts reach the password check', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => attempt('alice', `wrong-${i}`)),
    );
    expect(counter.calls).toBeLessThanOrEqual(LOCKOUT.maxAttempts);
    expect(results.every((r) => !isRedirect(r))).toBe(true);
    resetFailures('alice');
  });

  it('never more than two password checks run at once', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => attempt(`user-${i}`, 'wrong')));
    expect(counter.maxInFlight).toBeLessThanOrEqual(2);
    for (let i = 0; i < 12; i++) resetFailures(`user-${i}`);
  });

  it('a right password after a few wrong ones signs in and clears the count', async () => {
    for (let i = 0; i < LOCKOUT.maxAttempts - 1; i++) await attempt('asha', `wrong-${i}`);
    expect(isRedirect(await attempt('asha', 'the-right-one'))).toBe(true);
    // The count was cleared, so another nine wrong tries still leave room for the right one.
    for (let i = 0; i < LOCKOUT.maxAttempts - 1; i++) await attempt('asha', `wrong-${i}`);
    expect(isRedirect(await attempt('asha', 'the-right-one'))).toBe(true);
    resetFailures('asha');
  });

  it('wrong and locked answers keep one generic message', async () => {
    const wrong = (await attempt('meera', 'nope')) as { data: { message: string } };
    expect(wrong.data.message).toBe('Invalid username or password');
    resetFailures('meera');
  });
});
