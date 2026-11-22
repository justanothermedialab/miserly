/**
 * capture.integration.test.ts — the C2 global quick-add + C3 transfer actions,
 * plus the inline "Transfer → account" register path, driven end to end.
 * ============================================================================
 * The overlay/register post form-encoded data to route actions; this drives
 * those actions directly (browser OOMs here) and asserts persisted rows +
 * derived balances, so the capture wiring is proven without a browser.
 * `MISERLY_DB_PATH` points the singleton at a throwaway file.
 * ============================================================================
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-capture-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { accountBalance } from '../src/lib/server/db/balances';
import { actions as captureActions } from '../src/routes/capture/+page.server';
import { actions as registerActions } from '../src/routes/accounts/[id]/+page.server';

let alice: AuthedUser;
let checking: string;
let savings: string;

function user(): AuthedUser {
  return { id: alice.id, username: 'alice', role: 'admin' };
}

/** RequestEvent-shaped arg with a real form-encoded Request; params optional. */
function ev(fields: Record<string, string>, id?: string) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request('http://localhost/', { method: 'POST', body });
  return { locals: { user: user() }, params: id ? { id } : {}, request } as never;
}

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  checking = randomUUID();
  savings = randomUUID();
  db.insert(schema.accounts)
    .values([
      { id: checking, ownerId: alice.id, name: 'Checking', type: 'bank', currency: 'INR', openingPaise: 5000_00, openingDate: '2024-01-01' },
      { id: savings, ownerId: alice.id, name: 'Savings', type: 'bank', currency: 'INR', openingPaise: 0 },
    ])
    .run();
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('C2 /capture addTransaction (global quick-add)', () => {
  it('logs a transaction to a chosen account', async () => {
    const add = captureActions.addTransaction as (arg: never) => Promise<unknown>;
    const r = (await add(ev({ account: checking, date: '2024-02-01', outflow: '500', payee: 'Rent' }))) as { added?: boolean };
    expect(r.added).toBe(true);
    expect(accountBalance(getDb().sqlite, checking)).toBe(4500_00);
  });

  it('rejects a missing account with a 400 field error', async () => {
    const add = captureActions.addTransaction as (arg: never) => Promise<unknown>;
    const r = (await add(ev({ date: '2024-02-01', inflow: '10' }))) as { status?: number; data?: { errors?: Record<string, string> } };
    expect(r.status).toBe(400);
    expect(r.data?.errors?.account).toBeDefined();
  });
});

describe('C3 /capture addTransfer', () => {
  it('creates a linked pair and moves both balances', async () => {
    const before = accountBalance(getDb().sqlite, checking) + accountBalance(getDb().sqlite, savings);
    const add = captureActions.addTransfer as (arg: never) => Promise<unknown>;
    const r = (await add(ev({ from: checking, to: savings, amount: '1000', date: '2024-02-02' }))) as { transferred?: boolean };
    expect(r.transferred).toBe(true);
    // Net worth invariant; money moved.
    expect(accountBalance(getDb().sqlite, checking) + accountBalance(getDb().sqlite, savings)).toBe(before);
    expect(accountBalance(getDb().sqlite, savings)).toBe(1000_00);
  });

  it('rejects a self-transfer with a 400', async () => {
    const add = captureActions.addTransfer as (arg: never) => Promise<unknown>;
    const r = (await add(ev({ from: checking, to: checking, amount: '10', date: '2024-02-02' }))) as { status?: number };
    expect(r.status).toBe(400);
  });

  // Found in testing: a rate of "0" or with 7 decimals opened the error page (the parse threw
  // outside the action's checks). Each is a field error under Rate, nothing written.
  it.each([
    ['0', 'Enter a rate above 0'],
    ['83.1234567', 'Use at most 6 decimal places'],
  ])('a rate of %s is a field error, not the error page', async (rate, message) => {
    const add = captureActions.addTransfer as (arg: never) => Promise<unknown>;
    const before = accountBalance(getDb().sqlite, checking);
    const r = (await add(ev({ from: checking, to: savings, amount: '10', date: '2024-02-02', rate }))) as {
      status?: number;
      data?: { errors?: Record<string, string> };
    };
    expect(r.status).toBe(400);
    expect(r.data?.errors?.rate).toBe(message);
    expect(accountBalance(getDb().sqlite, checking)).toBe(before);
  });
});

describe('C3 inline "Transfer → account" via the register', () => {
  it('an outflow to "Transfer → Savings" creates a pair (money leaves this account)', async () => {
    const add = registerActions.addTransaction as (arg: never) => Promise<unknown>;
    const beforeChecking = accountBalance(getDb().sqlite, checking);
    const beforeSavings = accountBalance(getDb().sqlite, savings);
    const r = (await add(ev({ date: '2024-02-03', outflow: '250', payee: 'Transfer → Savings' }, checking))) as {
      added?: boolean;
      transfer?: boolean;
    };
    expect(r.added).toBe(true);
    expect(r.transfer).toBe(true);
    expect(accountBalance(getDb().sqlite, checking)).toBe(beforeChecking - 250_00);
    expect(accountBalance(getDb().sqlite, savings)).toBe(beforeSavings + 250_00);
  });
});
