/**
 * mc-register-display.integration.test.ts — MC3's account-header "≈ ₹X" /
 * "rate needed" line, end to end.
 * ============================================================================
 * Drives the ACTUAL route load (`routes/accounts/[id]/+page.server.ts`), the
 * same style as register-action.integration.test.ts. Proves the M9b addition
 * on top of that route: `baseApproxPaise` / `rateNeeded`, computed via the ONE
 * `toBase` boundary (never recomputed ad hoc) —
 *   - an INR account gets neither (redundant — native IS base);
 *   - a foreign account with a rate gets a correct `baseApproxPaise`;
 *   - a foreign account with NO rate gets `rateNeeded: true` and a null
 *     `baseApproxPaise` (MC1: never a silent 1:1).
 * ============================================================================
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-register-display-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { setRate } from '../src/lib/server/rates';
import { load as loadRaw } from '../src/routes/accounts/[id]/+page.server';

interface LoadResult {
  readonly baseApproxPaise: number | null;
  readonly rateNeeded: boolean;
  readonly view: { readonly account: { readonly currency: string } };
}
const load = loadRaw as unknown as (arg: never) => Promise<LoadResult>;

let alice: AuthedUser;
let inrAcctId: string;
let usdAcctId: string;
let eurAcctId: string;

function loadEv(user: AuthedUser | null, id: string) {
  return { locals: { user }, params: { id }, url: new URL(`http://localhost/accounts/${id}`) } as never;
}

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, {
    username: 'alice',
    displayName: 'Alice',
    password: 'alice-password-123',
  });
  inrAcctId = randomUUID();
  usdAcctId = randomUUID();
  eurAcctId = randomUUID();
  db.insert(schema.accounts)
    .values([
      { id: inrAcctId, ownerId: alice.id, name: 'HDFC', type: 'bank', currency: 'INR', openingPaise: 1000_00, openingDate: '2024-01-01' },
      { id: usdAcctId, ownerId: alice.id, name: 'US Brokerage', type: 'bank', currency: 'USD', openingPaise: 100_00, openingDate: '2024-01-01' },
      { id: eurAcctId, ownerId: alice.id, name: 'EU Savings', type: 'bank', currency: 'EUR', openingPaise: 200_00, openingDate: '2024-01-01' },
    ])
    .run();
  setRate(getDb(), 'USD', { scaled: 83_000_000, scale: 6 }); // 1 USD = 83 INR
  // EUR deliberately gets NO rate — the "rate needed" case.
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('account register load — MC3 native-primary/base-secondary', () => {
  it('an INR account gets no base-approx line (redundant) and is never "rate needed"', async () => {
    const result = await load(loadEv({ id: alice.id, username: 'alice', role: 'admin' }, inrAcctId));
    expect(result.baseApproxPaise).toBeNull();
    expect(result.rateNeeded).toBe(false);
  });

  it('a rated foreign account gets a correct base-approx figure via the one toBase boundary', async () => {
    const result = await load(loadEv({ id: alice.id, username: 'alice', role: 'admin' }, usdAcctId));
    expect(result.rateNeeded).toBe(false);
    expect(result.baseApproxPaise).toBe(8300_00); // $100 × 83
  });

  it('an unrated foreign account flags "rate needed" — never a silent 1:1', async () => {
    const result = await load(loadEv({ id: alice.id, username: 'alice', role: 'admin' }, eurAcctId));
    expect(result.rateNeeded).toBe(true);
    expect(result.baseApproxPaise).toBeNull();
  });
});
