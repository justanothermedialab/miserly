/**
 * m8-sections-action.integration.test.ts — the S1/S2/S3 ROUTE wiring, driven end
 * to end (browser OOMs here). The services are unit-tested in marks.test.ts; this
 * proves the route actions/loads parse the form, dispatch the onboarding shape,
 * sign the liability target, and surface the right outcomes — the in-session
 * substitute for a browser e2e (same posture as c4c5-action / route-guards).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { formatDate, today, systemClock } from '@miserly/core';
import type { AuthedUser } from '../src/lib/server/auth/session';

/** The onboarding mark is dated today; an "update value" defaults to today too
 *  (real UX), landing after it in ledger order so it governs the current value. */
const TODAY = formatDate(today(systemClock()));

const DB_PATH = path.join(os.tmpdir(), `miserly-m8-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { accountBalance } from '../src/lib/server/db/balances';
import { listAccounts } from '../src/lib/server/accounts';
import { holdingMetrics } from '../src/lib/server/dashboard';
import { actions as accountActions } from '../src/routes/accounts/+page.server';
import { actions as registerActions } from '../src/routes/accounts/[id]/+page.server';
import { load as sectionLoad } from '../src/routes/sections/[type]/+page.server';
import { load as sectionsIndexLoad } from '../src/routes/sections/+page.server';

let alice: AuthedUser;
function user(): AuthedUser {
  return { id: alice.id, username: 'alice', role: 'admin' };
}
function ev(fields: Record<string, string>, id?: string) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request('http://localhost/', { method: 'POST', body });
  return { locals: { user: user() }, params: id ? { id } : {}, request } as never;
}
function loadEv(params: Record<string, string> = {}) {
  return { locals: { user: user() }, params, url: new URL('http://localhost/') } as never;
}

beforeAll(async () => {
  const { db } = getDb();
  alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
});

afterAll(() => {
  getDb().sqlite.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

/** Find the just-created account by name. */
async function findByName(name: string): Promise<string> {
  const all = await listAccounts(getDb(), alice.id, { includeClosed: true });
  return all.find((a) => a.name === name)!.id;
}

describe('create action — onboarding dispatch', () => {
  it('onboards an asset holding with invested + current value (S2 RD1)', async () => {
    const create = accountActions.create as (arg: never) => Promise<unknown>;
    const r = (await create(ev({
      type: 'mutualFunds', name: 'Parag MF', currency: 'INR',
      invested: '300000', currentValue: '500000', openingDate: '2022-01-01',
      info_folio: 'PPFAS-123'
    }))) as { created?: boolean; accountId?: string };
    expect(r.created).toBe(true);

    const id = await findByName('Parag MF');
    // The Add account dialog opens the new account from this id (UX-REVIEW P14).
    expect(r.accountId).toBe(id);
    const m = await holdingMetrics(getDb(), alice.id, id);
    expect(m!.currentValuePaise).toBe(500000_00);
    expect(m!.costBasisPaise).toBe(300000_00);
    expect(m!.returnPaise).toBe(200000_00);
    // info_json captured the display-only field.
    const row = getDb().db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get()!;
    expect(JSON.parse(row.infoJson!)).toEqual({ folio: 'PPFAS-123' });
  });

  it('onboards a loan as a negative opening from the entered outstanding', async () => {
    const create = accountActions.create as (arg: never) => Promise<unknown>;
    await create(ev({ type: 'loan', name: 'Home Loan', currency: 'INR', outstanding: '5000000', openingDate: '2020-01-01' }));
    const id = await findByName('Home Loan');
    expect(accountBalance(getDb().sqlite, id)).toBe(-5000000_00); // owed → negative
  });

  it('opens a card or loan in credit from a negative outstanding', async () => {
    const create = accountActions.create as (arg: never) => Promise<unknown>;
    await create(ev({ type: 'creditCard', name: 'Overpaid Card', currency: 'INR', outstanding: '-2000', openingDate: '2026-10-01' }));
    expect(accountBalance(getDb().sqlite, await findByName('Overpaid Card'))).toBe(2000_00); // in credit → positive
    await create(ev({ type: 'loan', name: 'Overpaid Loan', currency: 'INR', outstanding: '-30000', openingDate: '2026-10-01' }));
    expect(accountBalance(getDb().sqlite, await findByName('Overpaid Loan'))).toBe(30000_00);
  });

  it('refuses a type that is not in the catalogue', async () => {
    const create = accountActions.create as (arg: never) => Promise<unknown>;
    // No coming-soon type is left since NPS (S5 RD17, 2026-11-19); an unknown one is refused.
    const r = (await create(ev({ type: 'crypto', name: 'My coins', currency: 'INR', invested: '1000', openingDate: '2024-01-01' }))) as { status?: number };
    expect(r.status).toBe(400);
  });

  it('creates the launch types: PPF, a Sovereign Gold Bond, a Home loan (S5 RD13, RD15)', async () => {
    const create = accountActions.create as (arg: never) => Promise<unknown>;
    await create(ev({ type: 'ppf', name: 'PPF (SBI)', currency: 'INR', invested: '485000', currentValue: '588700', openingDate: '2026-10-01', info_openedOn: '2019-06-12' }));
    await create(ev({ type: 'sgb', name: 'SGB 2023-24 III', currency: 'INR', invested: '123980', openingDate: '2026-10-01', info_grams: '20', info_issueDate: '2023-12-28' }));
    await create(ev({ type: 'loan', name: 'SBI home loan', currency: 'INR', outstanding: '4250000', openingDate: '2026-10-01', info_kind: 'Home loan' }));
    const row = async (name: string) => getDb().db.select().from(schema.accounts).where(eq(schema.accounts.name, name)).get()!;
    const ppf = await row('PPF (SBI)');
    expect(ppf.type).toBe('ppf');
    expect(accountBalance(getDb().sqlite, ppf.id)).toBe(588700_00);
    expect(JSON.parse(ppf.infoJson!)).toEqual({ openedOn: '2019-06-12' });
    expect((await row('SGB 2023-24 III')).type).toBe('sgb');
    const loan = await row('SBI home loan');
    expect(loan.type).toBe('loan');
    expect(JSON.parse(loan.infoJson!)).toEqual({ kind: 'Home loan' });
    expect(accountBalance(getDb().sqlite, loan.id)).toBe(-4250000_00);
  });
});

describe('mark action — S3 update value', () => {
  it('marks an asset holding up and reflects it in holdingMetrics', async () => {
    const id = await findByName('Parag MF');
    const mark = registerActions.mark as (arg: never) => Promise<unknown>;
    const r = (await mark(ev({ target: '520000', date: TODAY }, id))) as { marked?: boolean };
    expect(r.marked).toBe(true);
    const m = await holdingMetrics(getDb(), alice.id, id);
    expect(m!.currentValuePaise).toBe(520000_00);
    expect(accountBalance(getDb().sqlite, id)).toBe(520000_00);
    // A mark row exists carrying the asserted target.
    const marks = getDb().db.select().from(schema.transactions)
      .where(and(eq(schema.transactions.accountId, id), eq(schema.transactions.kind, 'valuationMark'))).all();
    expect(marks.some((mk) => mk.markTargetPaise === 520000_00)).toBe(true);
  });

  it('marks a LIABILITY to its outstanding (entered positive → stored negative)', async () => {
    const id = await findByName('Home Loan');
    const mark = registerActions.mark as (arg: never) => Promise<unknown>;
    await mark(ev({ target: '6000000', date: '2024-06-01' }, id)); // 60,00,000 owed
    expect(accountBalance(getDb().sqlite, id)).toBe(-6000000_00);
  });

  it('rejects a mark on a non-markable (bank) account', async () => {
    const create = accountActions.create as (arg: never) => Promise<unknown>;
    await create(ev({ type: 'bank', name: 'HDFC', currency: 'INR', opening: '10000', openingDate: '2024-01-01' }));
    const id = await findByName('HDFC');
    const mark = registerActions.mark as (arg: never) => Promise<unknown>;
    const r = (await mark(ev({ target: '5000', date: '2024-06-01' }, id))) as { status?: number };
    expect(r.status).toBe(400);
  });
});

describe('section loads', () => {
  it('the retired section index sends old links to All accounts (S1 RD7)', () => {
    expect(() => (sectionsIndexLoad as () => unknown)()).toThrow(expect.objectContaining({ status: 308, location: '/accounts' }));
  });

  it('a holding section carries per-account value/invested/return', async () => {
    const data = (await sectionLoad(loadEv({ type: 'mutualFunds' }))) as {
      totalPaise: number;
      accounts: { name: string; metrics: { currentValuePaise: number; returnPaise: number } | null }[];
    };
    expect(data.totalPaise).toBe(520000_00);
    const acc = data.accounts.find((a) => a.name === 'Parag MF')!;
    expect(acc.metrics!.currentValuePaise).toBe(520000_00);
    expect(acc.metrics!.returnPaise).toBe(220000_00); // 520000 − 300000 invested
  });
});
