/**
 * close-account.integration.test.ts — F1 RD15, the close action end to end.
 * A zero balance closes at once; money left is refused until the viewer says where it goes
 * (moved by a linked transfer, either sign, MC2 across currencies) or asks for the adjustment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-close-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { accountBalance } from '../src/lib/server/db/balances';
import { actions } from '../src/routes/accounts/[id]/+page.server';

let alice: AuthedUser;
const ids = {
  empty: randomUUID(),
  full: randomUUID(),
  card: randomUUID(),
  adjust: randomUUID(),
  usd: randomUUID(),
  dest: randomUUID(),
};

function ev(id: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request('http://localhost/', { method: 'POST', body });
  return { locals: { user: alice }, params: { id }, request } as never;
}
const close = (id: string, fields: Record<string, string> = {}) =>
  (actions.close as (arg: never) => Promise<unknown>)(ev(id, fields)) as Promise<{
    closed?: boolean;
    status?: number;
    data?: { errors: Record<string, string> };
  }>;
const status = (id: string) =>
  getDb().db.select().from(schema.accounts).all().find((a) => a.id === id)!.status;
const rows = (id: string) =>
  getDb().db.select().from(schema.transactions).all().filter((t) => t.accountId === id);

beforeAll(async () => {
  const { db } = getDb();
  const u = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  alice = { id: u.id, username: 'alice', role: 'admin' } as AuthedUser;
  const base = { ownerId: alice.id, type: 'bank', currency: 'INR', openingDate: '2024-01-01' } as const;
  db.insert(schema.accounts)
    .values([
      { ...base, id: ids.empty, name: 'Empty', openingPaise: 0 },
      { ...base, id: ids.full, name: 'HDFC', openingPaise: 12_400_00 },
      { ...base, id: ids.card, name: 'Card', type: 'credit_card', openingPaise: -3_000_00 },
      { ...base, id: ids.adjust, name: 'Old wallet', openingPaise: 50_00 },
      { ...base, id: ids.usd, name: 'Chase', currency: 'USD', openingPaise: 100_00 },
      { ...base, id: ids.dest, name: 'ICICI', openingPaise: 0 },
    ])
    .run();
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('F1 RD15 close action', () => {
  it('closes a zero-balance account at once, with no entry', async () => {
    expect((await close(ids.empty)).closed).toBe(true);
    expect(status(ids.empty)).toBe('closed');
    expect(rows(ids.empty)).toHaveLength(0);
  });

  it('refuses to close money left without a choice, and changes nothing', async () => {
    const r = await close(ids.full);
    expect(r.status).toBe(400);
    expect(r.data?.errors.closeTo).toBeTruthy();
    expect(status(ids.full)).toBe('open');
    expect(rows(ids.full)).toHaveLength(0);
  });

  it('moves a positive balance to the chosen account as a linked transfer, then closes', async () => {
    expect((await close(ids.full, { mode: 'move', toId: ids.dest })).closed).toBe(true);
    expect(status(ids.full)).toBe('closed');
    expect(accountBalance(getDb().sqlite, ids.full)).toBe(0);
    expect(accountBalance(getDb().sqlite, ids.dest)).toBe(12_400_00);
    const [out] = rows(ids.full);
    expect(out!.transferPartnerId).not.toBeNull();
  });

  it('pays a negative balance from the chosen account', async () => {
    expect((await close(ids.card, { mode: 'move', toId: ids.dest })).closed).toBe(true);
    expect(accountBalance(getDb().sqlite, ids.card)).toBe(0);
    expect(accountBalance(getDb().sqlite, ids.dest)).toBe(9_400_00);
  });

  it('closes with the adjustment when asked, even if an account was picked', async () => {
    expect((await close(ids.adjust, { mode: 'adjust', toId: ids.dest })).closed).toBe(true);
    expect(accountBalance(getDb().sqlite, ids.adjust)).toBe(0);
    expect(rows(ids.adjust)[0]!.transferPartnerId).toBeNull();
    expect(accountBalance(getDb().sqlite, ids.dest)).toBe(9_400_00);
  });

  it('across currencies needs the other amount, then moves both sides', async () => {
    const r = await close(ids.usd, { mode: 'move', toId: ids.dest });
    expect(r.status).toBe(400);
    expect(r.data?.errors.closeAmount).toBeTruthy();
    expect(status(ids.usd)).toBe('open');
    expect((await close(ids.usd, { mode: 'move', toId: ids.dest, otherAmount: '8300' })).closed).toBe(true);
    expect(accountBalance(getDb().sqlite, ids.usd)).toBe(0);
    expect(accountBalance(getDb().sqlite, ids.dest)).toBe(9_400_00 + 8_300_00);
  });
});
