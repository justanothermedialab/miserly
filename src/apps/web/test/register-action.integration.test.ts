/**
 * register-action.integration.test.ts — the C1 add-transaction ACTION, end to end.
 * ============================================================================
 * The service (createTransaction) and the boundary (transactionCreateSchema) are
 * unit-tested separately; this drives the actual route action
 * (`routes/accounts/[id]/+page.server.ts` → addTransaction) against a real
 * seeded DB — form-encoded rupees in, a persisted row + updated derived balance
 * out — so the whole capture wiring is proven without a browser (which OOMs
 * here). `MISERLY_DB_PATH` points the singleton at a throwaway file.
 * ============================================================================
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-register-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { accountBalance } from '../src/lib/server/db/balances';
import { actions } from '../src/routes/accounts/[id]/+page.server';

let alice: AuthedUser;
let acctId: string;
let closedId: string;

/** A RequestEvent-shaped arg carrying a real form-encoded Request. */
function ev(user: AuthedUser | null, id: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request('http://localhost/', { method: 'POST', body });
  return { locals: { user }, params: { id }, request } as never;
}

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, {
    username: 'alice',
    displayName: 'Alice',
    password: 'alice-password-123',
  });
  acctId = randomUUID();
  closedId = randomUUID();
  db.insert(schema.accounts)
    .values([
      { id: acctId, ownerId: alice.id, name: 'HDFC', type: 'bank', currency: 'INR', openingPaise: 1000_00, openingDate: '2024-01-01' },
      { id: closedId, ownerId: alice.id, name: 'Old', type: 'bank', currency: 'INR', status: 'closed', openingPaise: 0 },
    ])
    .run();
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('addTransaction action (end to end)', () => {
  it('persists an outflow and lowers the derived balance', async () => {
    const add = actions.addTransaction as (arg: never) => Promise<unknown>;
    const result = (await add(ev({ id: alice.id, username: 'alice', role: 'admin' }, acctId, {
      date: '2024-02-01',
      outflow: '300',
      payee: 'Groceries Co',
    }))) as { added?: boolean };
    expect(result.added).toBe(true);
    expect(accountBalance(getDb().sqlite, acctId)).toBe(700_00); // 1000 − 300

    const rows = getDb()
      .db.select()
      .from(schema.transactions)
      .all()
      .filter((t) => t.accountId === acctId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.amountPaise).toBe(-300_00);
    expect(rows[0]!.enteredBy).toBe(alice.id);
  });

  it('rejects both-columns-filled with a 400 (no row written)', async () => {
    const add = actions.addTransaction as (arg: never) => Promise<unknown>;
    const before = accountBalance(getDb().sqlite, acctId);
    const result = (await add(ev({ id: alice.id, username: 'alice', role: 'admin' }, acctId, {
      date: '2024-02-02',
      inflow: '10',
      outflow: '5',
    }))) as { status?: number };
    expect(result.status).toBe(400);
    expect(accountBalance(getDb().sqlite, acctId)).toBe(before); // unchanged
  });

  it('rejects an entry into a CLOSED account with a 400', async () => {
    const add = actions.addTransaction as (arg: never) => Promise<unknown>;
    const result = (await add(ev({ id: alice.id, username: 'alice', role: 'admin' }, closedId, {
      date: '2024-02-01',
      inflow: '50',
    }))) as { status?: number };
    expect(result.status).toBe(400);
  });
});
