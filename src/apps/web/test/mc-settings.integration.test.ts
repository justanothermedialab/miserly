/**
 * mc-settings.integration.test.ts — MC3 Settings → Currencies & rates, end to end.
 * ============================================================================
 * Drives the ACTUAL route (`routes/settings/+page.server.ts` load + the
 * `setRate` action) against a real seeded DB, the same style as
 * register-action.integration.test.ts (no browser — the 8GB box OOMs on
 * Playwright). Proves:
 *   - load() lists every ACTIVE foreign currency (viewer-scoped), "rate
 *     needed" for one with none, current rate + age for one that's set, and
 *     never lists a currency the viewer holds no account in;
 *   - the `?currency=` deep link is surfaced for the one-tap "set rate" nudge;
 *   - the setRate action persists via the real `rates.ts` store (parse errors
 *     surface as a field error; a valid save resets the "as of" timestamp so
 *     the next load's age is 0).
 * ============================================================================
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-settings-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { setRate as setRateDirect } from '../src/lib/server/rates';
import { load as loadRaw, actions, type RateSurfaceRow } from '../src/routes/settings/+page.server';

interface LoadResult {
  readonly baseCurrency: string;
  readonly rows: RateSurfaceRow[];
  readonly deepLinkCurrency: string | null;
}
// Cast away SvelteKit's generated `./$types` return-type magic (same pattern
// as `actions.foo as (arg: never) => Promise<unknown>` below) — this drives
// the route's load() directly against a hand-built event, not through the
// real request pipeline, so the generated types don't apply.
const load = loadRaw as unknown as (arg: never) => Promise<LoadResult>;

let alice: AuthedUser;
let usdAcctId: string;
let eurAcctId: string;

/** A minimal load-event shape: locals.user + a real URL (for searchParams) +
 *  a real Request (M11 load() reads `Accept-Language` off it for the SET1
 *  locale-derived prefs default). */
function loadEv(user: AuthedUser | null, urlStr = 'http://localhost/settings') {
  return { locals: { user }, url: new URL(urlStr), request: new Request(urlStr) } as never;
}

/** A minimal action-event shape carrying a real form-encoded Request. */
function actionEv(user: AuthedUser | null, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request('http://localhost/settings', { method: 'POST', body });
  return { locals: { user }, request } as never;
}

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, {
    username: 'alice',
    displayName: 'Alice',
    password: 'alice-password-123',
  });
  usdAcctId = randomUUID();
  eurAcctId = randomUUID();
  db.insert(schema.accounts)
    .values([
      { id: usdAcctId, ownerId: alice.id, name: 'US Brokerage', type: 'stocks', currency: 'USD', openingPaise: 1000_00, openingDate: '2024-01-01' },
      { id: eurAcctId, ownerId: alice.id, name: 'EU Savings', type: 'bank', currency: 'EUR', openingPaise: 500_00, openingDate: '2024-01-01' },
    ])
    .run();
  // EUR has a standing rate already; USD does not — the "rate needed" case.
  setRateDirect(getDb(), 'EUR', { scaled: 90_000_000, scale: 6 });
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

const authedUser: AuthedUser = { id: '', username: 'alice', role: 'admin' };

describe('settings load — Currencies & rates (MC3)', () => {
  it('redirects a signed-out visitor', async () => {
    await expect(load(loadEv(null))).rejects.toBeTruthy();
  });

  it('lists every active foreign currency, "rate needed" for USD, a rate + age for EUR', async () => {
    const result = await load(loadEv({ ...authedUser, id: alice.id }));
    expect(result.baseCurrency).toBe('INR');

    const byCurrency = new Map(result.rows.map((r) => [r.currency, r]));
    expect([...byCurrency.keys()].sort()).toEqual(['EUR', 'USD']);

    const usd = byCurrency.get('USD')!;
    expect(usd.rate).toBeNull();
    expect(usd.asOf).toBeNull();

    const eur = byCurrency.get('EUR')!;
    expect(eur.rate).toBe(90);
    expect(eur.daysAgo).toBe(0); // just set, in beforeAll
    expect(eur.stale).toBe(false);
  });

  it('never lists a currency the viewer holds no account in', async () => {
    // GBP has no account anywhere — even though nothing prevents a rate row
    // for it from existing in the store, it must not surface here (MC1's
    // "active" rule: used by ≥1 of the VIEWER's accounts).
    setRateDirect(getDb(), 'GBP', { scaled: 100_000_000, scale: 6 });
    const result = await load(loadEv({ ...authedUser, id: alice.id }));
    expect(result.rows.some((r) => r.currency === 'GBP')).toBe(false);
  });

  it('surfaces the ?currency= deep link for the one-tap "set rate" nudge', async () => {
    const result = await load(loadEv({ ...authedUser, id: alice.id }, 'http://localhost/settings?currency=usd'));
    expect(result.deepLinkCurrency).toBe('USD');
  });

  it('has no deep link when the query param is absent', async () => {
    const result = await load(loadEv({ ...authedUser, id: alice.id }));
    expect(result.deepLinkCurrency).toBeNull();
  });
});

describe('settings setRate action — persists via the real rates.ts store', () => {
  it('sets a fresh rate for USD and resets its "as of" to today', async () => {
    const setRate = actions.setRate as (arg: never) => Promise<unknown>;
    const result = (await setRate(
      actionEv({ ...authedUser, id: alice.id }, { currency: 'usd', rate: '83.25' }),
    )) as { saved?: boolean; currency?: string };
    expect(result.saved).toBe(true);
    expect(result.currency).toBe('USD');

    const after = await load(loadEv({ ...authedUser, id: alice.id }));
    const usd = after.rows.find((r) => r.currency === 'USD')!;
    expect(usd.rate).toBe(83.25);
    expect(usd.daysAgo).toBe(0);
  });

  it('surfaces a parse error as a field error (no write) for malformed input', async () => {
    const before = (await load(loadEv({ ...authedUser, id: alice.id }))).rows.find(
      (r) => r.currency === 'EUR',
    )!;
    const setRate = actions.setRate as (arg: never) => Promise<unknown>;
    const result = (await setRate(
      actionEv({ ...authedUser, id: alice.id }, { currency: 'EUR', rate: 'not-a-number' }),
    )) as { status?: number; data?: { errors?: { rate?: string } } };
    expect(result.status).toBe(400);
    expect(result.data?.errors?.rate).toBe('Enter a rate like 83.10');

    const after = (await load(loadEv({ ...authedUser, id: alice.id }))).rows.find(
      (r) => r.currency === 'EUR',
    )!;
    expect(after.rate).toBe(before.rate); // unchanged
  });

  it('rejects a negative/zero rate', async () => {
    const setRate = actions.setRate as (arg: never) => Promise<unknown>;
    const result = (await setRate(
      actionEv({ ...authedUser, id: alice.id }, { currency: 'USD', rate: '-5' }),
    )) as { status?: number };
    expect(result.status).toBe(400);
  });

  it('refuses to set a rate for the base currency itself', async () => {
    const setRate = actions.setRate as (arg: never) => Promise<unknown>;
    const result = (await setRate(
      actionEv({ ...authedUser, id: alice.id }, { currency: 'INR', rate: '1' }),
    )) as { status?: number };
    expect(result.status).toBe(400);
  });
});

describe('S6 (security read): only a holder of a currency sets its rate', () => {
  it('a member with no USD account is refused, and the rate is unchanged', async () => {
    const { createMember } = await import('../src/lib/server/auth/users');
    const bob = await createMember(getDb().db, { username: 'bob-s6', displayName: 'Bob', tempPassword: 'bob-password-123' });
    const before = (await load(loadEv({ ...authedUser, id: alice.id }))).rows.find((r) => r.currency === 'USD')!;
    const setRate = actions.setRate as (arg: never) => Promise<unknown>;
    const result = (await setRate(
      actionEv({ id: bob.id, username: 'bob-s6', role: 'member' }, { currency: 'USD', rate: '1' }),
    )) as { status?: number; data?: { errors?: { rate?: string } } };
    expect(result.status).toBe(400);
    expect(result.data?.errors?.rate).toBe("You hold no account in USD, so you can't set its rate.");
    const after = (await load(loadEv({ ...authedUser, id: alice.id }))).rows.find((r) => r.currency === 'USD')!;
    expect(after.rate).toBe(before.rate);
  });

  it('a made-up currency is refused the same way', async () => {
    const setRate = actions.setRate as (arg: never) => Promise<unknown>;
    const result = (await setRate(
      actionEv({ ...authedUser, id: alice.id }, { currency: 'ZZZ', rate: '1' }),
    )) as { status?: number };
    expect(result.status).toBe(400);
  });
});
