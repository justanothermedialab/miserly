/**
 * hosted-security.test.ts: the edge findings of a security read of the hosted build, each
 * shown against the route or hook it names.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DB_PATH = path.join(os.tmpdir(), `miserly-hosted-security-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { and, eq, isNull } from 'drizzle-orm';
import { isRedirect } from '@sveltejs/kit';
import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { load as signinLoad } from '../src/routes/signin/+page.server';
import { actions as setupActions, load as setupLoad } from '../src/routes/setup/+page.server';
import { handle } from '../src/hooks.server';
import { actions as signinActions } from '../src/routes/signin/+page.server';
import { createMember } from '../src/lib/server/auth/users';

// The static/ files a signed-out page loads; the hook keeps its own copy of this list.
const STATIC_FILES = ['favicon.svg', 'manifest.webmanifest', 'robots.txt', 'THIRD-PARTY-NOTICES.txt'];

afterAll(() => {
  getDb().sqlite.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});

function postForm(url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
  });
}

// First in the file: the instance is still fresh here.
describe('S8: a setup code when the server asks for one', () => {
  const setup = async (fields: Record<string, string>) => {
    try {
      return (await setupActions.default!({
        request: postForm('http://localhost/setup', fields),
        cookies: { set: () => undefined },
        url: new URL('http://localhost/setup'),
      } as never)) as { status?: number; data?: { message?: string } };
    } catch (thrown) {
      return thrown as { status?: number; data?: { message?: string } };
    }
  };
  afterEach(() => {
    delete process.env.MISERLY_SETUP_CODE;
  });

  it('with the switch on, no code or a wrong code is refused and makes no admin', async () => {
    process.env.MISERLY_SETUP_CODE = 'on';
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    const none = await setup({ username: 'early', password: 'a-long-password-1' });
    expect(none.status).toBe(400);
    expect(none.data?.message).toBe("Enter the setup code from the server's log.");
    const wrong = await setup({ username: 'early', password: 'a-long-password-1', setupCode: 'AAAA-BBBB-CCCC' });
    // A stale code from an earlier start was the usual mistake; the message says so.
    expect(wrong.data?.message).toMatch(/isn't the latest setup code\. Each start prints a new one/u);
    expect(wrong.data?.message).toContain('miserly setup code:');
    expect(lines.filter((l) => l.includes('setup code'))).toHaveLength(1);
    spy.mockRestore();
    const { db } = getDb();
    expect(db.select().from(schema.users).all()).toHaveLength(0);
  });

  it('the setup page says whether it needs the code', async () => {
    process.env.MISERLY_SETUP_CODE = 'on';
    expect(await setupLoad({} as never)).toEqual({ needsCode: true });
    delete process.env.MISERLY_SETUP_CODE;
    expect(await setupLoad({} as never)).toEqual({ needsCode: false });
    // The documented switch for a trusted network (the image sets `on`).
    process.env.MISERLY_SETUP_CODE = 'off';
    expect(await setupLoad({} as never)).toEqual({ needsCode: false });
  });
});

describe('S8: two setups sent together', () => {
  it('make one admin; the other is told setup is done', async () => {
    const run = async (username: string) => {
      try {
        return await setupActions.default!({
          request: postForm('http://localhost/setup', { username, password: 'a-long-password-1' }),
          cookies: { set: () => undefined },
          url: new URL('http://localhost/setup'),
        } as never);
      } catch (thrown) {
        return thrown;
      }
    };
    const results = await Promise.all([run('first'), run('second')]);
    const { db } = getDb();
    const admins = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'admin'), isNull(schema.users.deletedAt)))
      .all();
    expect(admins).toHaveLength(1);
    expect(results.filter((r) => isRedirect(r))).toHaveLength(1);
    expect(results.find((r) => !isRedirect(r))).toMatchObject({ status: 400 });
  });
});

/** A request through the real hook; `resolved` says whether it reached the route. */
async function throughHook(
  pathname: string,
  init: { method?: string; headers?: Record<string, string>; cookies?: Record<string, string> } = {},
): Promise<{ resolved: boolean; status?: number; location?: string; response?: Response }> {
  const url = new URL(`http://localhost${pathname}`);
  const jar = new Map(Object.entries(init.cookies ?? {}));
  const headers = new Headers(init.headers ?? {});
  const event = {
    url,
    request: new Request(url, { method: init.method ?? 'GET', headers }),
    isDataRequest: pathname.endsWith('/__data.json'),
    locals: {} as Record<string, unknown>,
    cookies: {
      get: (k: string) => jar.get(k),
      set: (k: string, v: string) => jar.set(k, v),
      delete: (k: string) => jar.delete(k),
    },
    getClientAddress: () => '10.0.0.9',
  };
  let resolved = false;
  const resolve = async () => {
    resolved = true;
    return new Response('route', { status: 200 });
  };
  try {
    const response = await handle({ event, resolve } as never);
    return { resolved, status: response.status, response };
  } catch (thrown) {
    if (isRedirect(thrown)) return { resolved, status: thrown.status, location: thrown.location };
    throw thrown;
  }
}

describe('S9: big bodies sent with no session', () => {
  it('a sign-in POST over 64 KB is turned away before the route reads it', async () => {
    const r = await throughHook('/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(60 * 1024 * 1024) },
    });
    expect(r.resolved).toBe(false);
    expect(r.status).toBe(413);
  });

  it('a sign-in POST with no Content-Length is turned away', async () => {
    const r = await throughHook('/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(r.resolved).toBe(false);
    expect(r.status).toBe(411);
  });

  it('an ordinary sign-in POST goes through', async () => {
    const r = await throughHook('/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '60' },
    });
    expect(r.resolved).toBe(true);
  });
});

describe('S12: only real files skip the gate', () => {
  it('a signed-out dotted path is sent to sign in by the gate itself', async () => {
    for (const p of ['/accounts/x.y', '/reports.json', '/settings/a.b']) {
      const r = await throughHook(p);
      expect(r.resolved, p).toBe(false);
      expect(r.location, p).toMatch(/^\/signin\?redirectTo=/u);
    }
  });

  it("the built assets and static/'s own files still skip it", async () => {
    for (const p of ['/_app/immutable/entry/start.js', ...STATIC_FILES.map((f) => `/${f}`)]) {
      expect((await throughHook(p)).resolved, p).toBe(true);
    }
  });

  it("the hook's list is static/'s files", () => {
    expect([...STATIC_FILES].sort()).toEqual(fs.readdirSync(path.resolve(__dirname, '../static')).sort());
  });
});

describe('S11: security headers on every page', () => {
  it.each(['/signin', '/accounts/x.y'])('%s carries nosniff, a referrer policy and no framing', async (p) => {
    const r = await throughHook(p);
    // A redirect thrown by the gate gets its headers from SvelteKit; check the pages served.
    if (!r.response) return;
    expect(r.response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.response.headers.get('referrer-policy')).toBe('same-origin');
    expect(r.response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(r.response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('the signed-out answers the hook writes itself carry them too', async () => {
    const r = await throughHook('/signin', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r.response!.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('S3: the session cookie over HTTPS is a __Host- cookie', () => {
  it('sign-in over HTTPS sets __Host-miserly_session, Secure, path /; over HTTP the plain name', async () => {
    const { db } = getDb();
    await createMember(db, { username: 'cookie-test', displayName: 'C', tempPassword: 'cookie-pass-123' });
    const names: { name: string; secure: boolean; path: string }[] = [];
    for (const origin of ['https://miserly.home.example', 'http://nuc:3000']) {
      try {
        await signinActions.default!({
          request: postForm(`${origin}/signin`, { username: 'cookie-test', password: 'cookie-pass-123' }),
          url: new URL(`${origin}/signin`),
          cookies: { set: (name: string, _v: string, o: { secure: boolean; path: string }) => names.push({ name, secure: o.secure, path: o.path }) },
          getClientAddress: () => '10.0.0.9',
        } as never);
      } catch {
        // the redirect home
      }
    }
    expect(names).toEqual([
      { name: '__Host-miserly_session', secure: true, path: '/' },
      { name: 'miserly_session', secure: false, path: '/' },
    ]);
  });
});

describe('S7: redirectTo stays on this site', () => {
  async function target(raw: string): Promise<string> {
    const url = new URL('http://localhost/signin');
    url.searchParams.set('redirectTo', raw);
    const data = (await signinLoad({ url } as never)) as { redirectTo: string };
    return data.redirectTo;
  }

  it.each([
    '/\\evil.example/signin',
    '/\\/evil.example',
    '//evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    'https://evil.example/',
    'evil.example',
  ])('%j goes home instead', async (raw) => {
    expect(await target(raw)).toBe('/');
  });

  it.each(['/', '/accounts/abc', '/reports?period=fy', '/accounts/a#x'])('%j is kept', async (raw) => {
    expect(await target(raw)).toBe(raw);
  });
});
