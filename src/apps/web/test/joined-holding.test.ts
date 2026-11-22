/**
 * joined-holding.test.ts: a member added to a holding later is measured from the day they joined
 * (H2, S2). The worked
 * fund: Alice put ₹10,00,000 in on 1 Apr 2019; it is worth ₹18,00,000; she shares it half with
 * Bob from 1 Nov 2026.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-joined-holding-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin, createMember } from '../src/lib/server/auth/users';
import { createAccount } from '../src/lib/server/accounts';
import { postValuationMark } from '../src/lib/server/marks';
import { holdingMetrics, valueInvestedHistory } from '../src/lib/server/dashboard';
import { load as sectionLoad } from '../src/routes/sections/[type]/+page.server';

const L = 1_00_000_00; // ₹1,00,000 in paise
let alice: AuthedUser;
let bob: AuthedUser;
let fund: string;

beforeAll(async () => {
  const db = getDb();
  alice = await createAdmin(db.db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
  bob = await createMember(db.db, { username: 'bob', displayName: 'Bob', tempPassword: 'bob-password-123' });
  fund = (await createAccount(db, { ownerId: alice.id, type: 'mutualFunds', name: 'Index fund', currency: 'INR', openingPaise: 10 * L, openingDate: '2019-04-01' })).id;
  await postValuationMark(db, { userId: alice.id }, { accountId: fund, targetPaise: 18 * L, date: '2026-03-31' });
  // Shared half and half with Bob from 1 Nov 2026 (as the share action would have written it that day).
  db.db.insert(schema.accountMembers).values({ accountId: fund, userId: bob.id }).run();
  db.db.insert(schema.accountHolderPeriods).values({ accountId: fund, userId: bob.id, fromDate: '2026-11-01', toDate: null }).run();
  db.db.insert(schema.accountShares).values([
    { accountId: fund, userId: alice.id, effectiveFrom: '2026-11-01', shareBp: 5000 },
    { accountId: fund, userId: bob.id, effectiveFrom: '2026-11-01', shareBp: 5000 },
  ]).run();
});
afterAll(() => {
  getDb().sqlite.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});

type SectionRow = { id: string; metrics: { currentValuePaise: number; costBasisPaise: number; returnPaise: number } | false | null };
async function sectionRow(user: AuthedUser): Promise<SectionRow> {
  const data = (await sectionLoad({ params: { type: 'mutualFunds' }, locals: { user }, url: new URL('http://localhost/sections/mutualFunds') } as never)) as { accounts: SectionRow[] };
  return data.accounts.find((a) => a.id === fund)!;
}

describe("S15, L10: Bob, who joined on 1 Nov 2026, from Bob's side", () => {
  it('the register header: Invested is the value the day he joined, no return yet, tracked since then', async () => {
    const m = (await holdingMetrics(getDb(), bob.id, fund))!;
    expect(m).toMatchObject({ currentValuePaise: 18 * L, costBasisPaise: 18 * L, returnPaise: 0, trackedSince: '2026-11-01', annualReturn: null });
  });

  it('the section row: his half of the same', async () => {
    const row = await sectionRow(bob);
    expect(row.metrics).toMatchObject({ currentValuePaise: 9 * L, costBasisPaise: 9 * L, returnPaise: 0 });
  });

  it("the chart: Invested starts at the value on the day he joined", async () => {
    const h = (await valueInvestedHistory(getDb(), bob.id, { accountId: fund }, 'ALL'))!;
    expect(h.points[0]).toEqual({ date: '2026-11-01', valuePaise: 18 * L, investedPaise: 18 * L });
    const s = (await valueInvestedHistory(getDb(), bob.id, { type: 'mutualFunds' }, 'ALL'))!;
    expect(s.points[0]).toEqual({ date: '2026-11-01', valuePaise: 9 * L, investedPaise: 9 * L });
  });
});

describe("S15, L10: Alice's figures don't change", () => {
  it('her header, her row and her chart', async () => {
    const m = (await holdingMetrics(getDb(), alice.id, fund))!;
    expect(m).toMatchObject({ currentValuePaise: 18 * L, costBasisPaise: 10 * L, returnPaise: 8 * L, trackedSince: '2019-04-01' });
    expect(m.annualReturn).not.toBeNull();
    expect((await sectionRow(alice)).metrics).toMatchObject({ currentValuePaise: 9 * L, costBasisPaise: 5 * L, returnPaise: 4 * L });
    const h = (await valueInvestedHistory(getDb(), alice.id, { accountId: fund }, 'ALL'))!;
    expect(h.points[0]).toEqual({ date: '2019-04-01', valuePaise: 10 * L, investedPaise: 10 * L });
  });
});
