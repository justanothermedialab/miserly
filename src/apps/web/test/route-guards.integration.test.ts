/**
 * route-guards.integration.test.ts — the P0 privacy invariant proven at the
 * SERVER BOUNDARY, without a browser.
 * ============================================================================
 * The Playwright privacy spec (tests/privacy.spec.ts) proves the same thing via
 * a real browser + built server, but that stack (vite build + node preview +
 * Chromium) does not fit this machine's RAM. This suite drives the ACTUAL route
 * `load` functions (`src/routes/accounts/[id]/+page.server.ts` and
 * `src/routes/+page.server.ts`) directly against an in-memory-seeded real DB and
 * asserts the server-side scoping: a non-holder cannot load — or even learn of
 * the existence of — an account they don't own or share; an admin gets no
 * special access; the visible set is `owned ∪ member-of`. This is a stronger,
 * deterministic check of the boundary than DOM assertions, and it runs in tens
 * of MB. `MISERLY_DB_PATH` points `getDb()` at a throwaway temp file.
 * ============================================================================
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import type { AuthedUser } from '../src/lib/server/auth/session';

// Point the app db singleton at a throwaway file BEFORE getDb() is ever called
// (getDb is lazy, so this top-level assignment lands in time).
const DB_PATH = path.join(os.tmpdir(), `miserly-routeguard-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin, createMember } from '../src/lib/server/auth/users';
import { load as accountLoad, actions as accountActions } from '../src/routes/accounts/[id]/+page.server';
import { load as homeLoad } from '../src/routes/+page.server';
import { load as layoutLoad } from '../src/routes/+layout.server';

interface Seeded {
  alice: AuthedUser;
  bob: AuthedUser;
  carol: AuthedUser;
  alicePrivate: string;
  aliceShared: string;
  bobOwn: string;
}
let s: Seeded;

type AccountData = { view: { account: { id: string; name: string; type: string } } };
// Since session 4 the account list lives in the sidebar (the layout load's nav, S1 RD7; the
// dashboard dropped its copy, D4 RD9). Reading the names from there proves the viewer-scoping of
// every signed-in page's account list; the home load is still checked for its own figures.
type HomeData = { summary: { hasOpenAccounts: boolean } };
type LayoutData = { nav: { sections: { type: string; accounts: { id: string; name: string }[] }[] } | null };
const navNames = (d: LayoutData): string[] =>
  (d.nav?.sections ?? []).flatMap((g) => g.accounts.map((a) => a.name)).sort();
/** The layout load also reads the request (language) and cookies (collapsed sections). */
function layoutEv(user: AuthedUser | null) {
  return {
    locals: { user },
    params: {},
    url: new URL('http://localhost/'),
    request: new Request('http://localhost/'),
    cookies: { get: () => undefined },
    depends: () => {},
  } as never;
}

/** A minimal `RequestEvent`-shaped arg — the loads read `locals` / `params` / `url`
 *  (the dashboard home load reads `url.searchParams` for the timeframe). */
function ev(user: AuthedUser | null, params: Record<string, string> = {}) {
  return { locals: { user }, params, url: new URL('http://localhost/') } as never;
}

/** Call a load, capturing either its returned data or the thrown redirect/error.
 *  Typed loosely because SvelteKit `PageServerLoad` returns `MaybePromise`; the
 *  call sites cast `data` to the concrete page shape. */
async function run(
  fn: (arg: never) => unknown,
  arg: never,
): Promise<{ data?: unknown; thrown?: unknown }> {
  try {
    return { data: await fn(arg) };
  } catch (thrown) {
    return { thrown };
  }
}

beforeAll(async () => {
  const { db } = getDb();
  const alice = await createAdmin(db, {
    username: 'alice',
    displayName: 'Alice',
    password: 'alice-password-123',
  });
  const bob = await createMember(db, {
    username: 'bob',
    displayName: 'Bob',
    tempPassword: 'bob-password-123',
  });
  const carol = await createMember(db, {
    username: 'carol',
    displayName: 'Carol',
    tempPassword: 'carol-password-123',
  });

  const alicePrivate = randomUUID();
  const aliceShared = randomUUID();
  const bobOwn = randomUUID();
  db.insert(schema.accounts)
    .values([
      { id: alicePrivate, ownerId: alice.id, name: 'Alice Private', type: 'bank', currency: 'INR', openingPaise: 0 },
      { id: aliceShared, ownerId: alice.id, name: 'Alice Shared', type: 'bank', currency: 'INR', openingPaise: 0 },
      { id: bobOwn, ownerId: bob.id, name: 'Bob Own', type: 'bank', currency: 'INR', openingPaise: 0 },
    ])
    .run();
  db.insert(schema.accountMembers).values({ accountId: aliceShared, userId: bob.id }).run();

  s = { alice, bob, carol, alicePrivate, aliceShared, bobOwn };
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('route boundary: accounts/[id] load enforces visibility server-side', () => {
  it('an UNAUTHENTICATED request is redirected to /signin (never reaches data)', async () => {
    const { thrown } = await run(accountLoad, ev(null, { id: s.alicePrivate }));
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { status: number }).status).toBe(303);
    expect((thrown as { location: string }).location).toBe('/signin');
  });

  it('a MEMBER can load an account shared with them (200-equivalent: data returned)', async () => {
    const bobUser: AuthedUser = { id: s.bob.id, username: 'bob', role: 'member' };
    const { data } = await run(accountLoad, ev(bobUser, { id: s.aliceShared }));
    expect((data as AccountData).view.account.name).toBe('Alice Shared');
  });

  it("a non-holder gets 404 for a private account — IDENTICAL to a bogus id (existence NOT leaked)", async () => {
    const bobUser: AuthedUser = { id: s.bob.id, username: 'bob', role: 'member' };
    const priv = await run(accountLoad, ev(bobUser, { id: s.alicePrivate }));
    const bogus = await run(accountLoad, ev(bobUser, { id: 'this-id-does-not-exist' }));

    expect(isHttpError(priv.thrown)).toBe(true);
    expect(isHttpError(bogus.thrown)).toBe(true);
    expect((priv.thrown as { status: number }).status).toBe(404);
    expect((bogus.thrown as { status: number }).status).toBe(404);
    // Same status AND same body → a non-holder cannot distinguish "exists but
    // hidden" from "does not exist". This is the P0 privacy guarantee.
    expect((priv.thrown as { body: unknown }).body).toEqual((bogus.thrown as { body: unknown }).body);
  });

  it('the ADMIN is NOT privileged: 404 for an account they neither own nor share', async () => {
    const aliceUser: AuthedUser = { id: s.alice.id, username: 'alice', role: 'admin' };
    const { thrown } = await run(accountLoad, ev(aliceUser, { id: s.bobOwn }));
    expect(isHttpError(thrown)).toBe(true);
    expect((thrown as { status: number }).status).toBe(404);
  });
});

describe('route boundary: Edit account (UX-REVIEW P7) is refused to a non-holder like a bogus id', () => {
  const editEv = (user: AuthedUser, id: string) => {
    const body = new FormData();
    body.set('name', 'Hijacked');
    body.set('opening', '0');
    return { locals: { user }, params: { id }, url: new URL('http://localhost/'), request: new Request('http://localhost/', { method: 'POST', body }) } as never;
  };
  it('404 for a private account, the same as for an id that does not exist; nothing renamed', async () => {
    const bobUser: AuthedUser = { id: s.bob.id, username: 'bob', role: 'member' };
    const edit = accountActions.editAccount as (arg: never) => unknown;
    const priv = await run(edit, editEv(bobUser, s.alicePrivate));
    const bogus = await run(edit, editEv(bobUser, 'this-id-does-not-exist'));
    expect((priv.thrown as { status: number }).status).toBe(404);
    expect((priv.thrown as { body: unknown }).body).toEqual((bogus.thrown as { body: unknown }).body);
    const row = getDb().db.select().from(schema.accounts).all().find((a) => a.id === s.alicePrivate);
    expect(row?.name).toBe('Alice Private');
  });
});

describe('route boundary: the account list (sidebar) and home load return only the viewer-visible set', () => {
  it('a member sees exactly owned ∪ member-of (not other private accounts)', async () => {
    const bobUser: AuthedUser = { id: s.bob.id, username: 'bob', role: 'member' };
    const { data } = await run(layoutLoad, layoutEv(bobUser));
    expect(navNames(data as LayoutData)).toEqual(['Alice Shared', 'Bob Own']);
  });

  it('a member with no accounts sees an empty set (never "all")', async () => {
    const carolUser: AuthedUser = { id: s.carol.id, username: 'carol', role: 'member' };
    const { data: nav } = await run(layoutLoad, layoutEv(carolUser));
    expect((nav as LayoutData).nav?.sections).toEqual([]);
    const { data } = await run(homeLoad, ev(carolUser));
    expect((data as HomeData).summary.hasOpenAccounts).toBe(false);
  });

  it('an unauthenticated home load is redirected to /signin', async () => {
    const { thrown } = await run(homeLoad, ev(null));
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { status: number }).status).toBe(303);
  });
});
