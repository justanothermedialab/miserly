/**
 * session-ended-save.test.ts: a dialog's Save after the session has ended (hosted audit H1).
 * The hook answers the post with a redirect to sign-in; the dialog's own handler must follow it
 * back to the page the person was on, and show a line for an error, instead of doing nothing.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DB_PATH = path.join(os.tmpdir(), `miserly-session-ended-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { isRedirect } from '@sveltejs/kit';
import { getDb } from '../src/lib/server/db/instance';
import { createAdmin } from '../src/lib/server/auth/users';
import { handle } from '../src/hooks.server';
import { followOtherResult, redirectDestination } from '../src/lib/forms';

afterAll(() => {
  getDb().sqlite.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});

/** A signed-out form post through the real hook; returns the redirect's location. */
async function postSignedOut(pathname: string): Promise<string> {
  const url = new URL(`http://localhost${pathname}`);
  const body = 'account=x&outflow=10';
  const event = {
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(body.length),
        origin: 'http://localhost',
      },
      body,
    }),
    isDataRequest: false,
    locals: {} as Record<string, unknown>,
    cookies: { get: () => undefined, set: () => {}, delete: () => {} },
    getClientAddress: () => '10.0.0.9',
  };
  let resolved = false;
  try {
    await handle({ event, resolve: async () => ((resolved = true), new Response('route')) } as never);
  } catch (thrown) {
    if (isRedirect(thrown)) {
      expect(resolved).toBe(false);
      return thrown.location;
    }
    throw thrown;
  }
  throw new Error('the hook let a signed-out post through');
}

describe('H1: Save after the session has ended', () => {
  it("Quick add's and Add account's actions answer a redirect to sign-in with no session", async () => {
    const { db } = getDb();
    await createAdmin(db, { username: 'asha', displayName: 'Asha', password: 'a-long-password-1' });
    for (const action of ['/capture?/addTransaction', '/capture?/addTransfer', '/accounts?/create']) {
      expect(await postSignedOut(action)).toMatch(/^\/signin\?redirectTo=/u);
    }
  });

  it('the handler goes to sign-in and comes back to the page, not to the action', async () => {
    const location = await postSignedOut('/capture?/addTransaction');
    const navigate = vi.fn(async () => {});
    const showError = vi.fn();
    const here = new URL('http://localhost/accounts/abc?view=all');
    const handled = await followOtherResult({ type: 'redirect', location }, { here, navigate, showError, message: 'x' });
    expect(handled).toBe(true);
    expect(navigate).toHaveBeenCalledWith(`/signin?redirectTo=${encodeURIComponent('/accounts/abc?view=all')}`);
    expect(showError).not.toHaveBeenCalled();
  });

  it('an error result shows the line; success and failure are left to the caller', async () => {
    const navigate = vi.fn(async () => {});
    const showError = vi.fn();
    const here = new URL('http://localhost/');
    expect(await followOtherResult({ type: 'error' }, { here, navigate, showError, message: 'Could not save. Try again.' })).toBe(true);
    expect(showError).toHaveBeenCalledWith('Could not save. Try again.');
    for (const type of ['success', 'failure']) {
      expect(await followOtherResult({ type }, { here, navigate, showError, message: 'x' })).toBe(false);
    }
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a redirect somewhere other than sign-in is followed as it is', () => {
    const here = new URL('http://localhost/settings');
    expect(redirectDestination('/', here)).toBe('/');
    expect(redirectDestination('/change-password', here)).toBe('/change-password');
    expect(redirectDestination('/signin', here)).toBe('/signin?redirectTo=%2Fsettings');
  });
});
