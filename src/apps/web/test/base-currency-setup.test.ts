/**
 * base-currency-setup.test.ts: setup asks for the currency totals are in and the month the year
 * starts in (H1, MC1 RD2 amended, R1), written with the first admin.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DB_PATH = path.join(os.tmpdir(), `miserly-base-setup-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { actions as setupActions } from '../src/routes/setup/+page.server';
import { baseCurrency, yearStartMonth } from '../src/lib/server/settings';
import { BASE_CURRENCY_CHOICES, defaultYearStartFor } from '../src/lib/currencies';
import { load as layoutLoad } from '../src/routes/+layout.server';
import { load as reportsLoad } from '../src/routes/reports/+page.server';
import { readActualExport } from '../src/lib/server/import/actual-read';
import { previewImport, runImport, defaultChoices } from '../src/lib/server/import/actual-import';
import { today, systemClock } from '@miserly/core';

const SAMPLE = path.resolve(__dirname, 'fixtures/Sample-budget-export.zip');

afterAll(() => {
  getDb().sqlite.close();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
});

async function setup(fields: Record<string, string>) {
  try {
    return (await setupActions.default!({
      request: new Request('http://localhost/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
      }),
      cookies: { set: () => undefined },
      url: new URL('http://localhost/setup'),
    } as never)) as { status?: number; data?: { message?: string } };
  } catch (thrown) {
    return thrown as { status?: number; data?: { message?: string } };
  }
}

const login = { username: 'ana', password: 'a-long-password-1' };

describe('the choices offered', () => {
  it('are the two-decimal supported currencies (no JPY, sweep A5)', async () => {
    expect(BASE_CURRENCY_CHOICES).toContain('INR');
    expect(BASE_CURRENCY_CHOICES).toContain('USD');
    expect(BASE_CURRENCY_CHOICES).not.toContain('JPY');
  });
  it('preselect April for rupees and January for any other currency', async () => {
    expect(defaultYearStartFor('INR')).toBe(4);
    expect(defaultYearStartFor('USD')).toBe(1);
    expect(defaultYearStartFor('EUR')).toBe(1);
  });
});

describe('setup (a fresh instance)', () => {
  it('reads rupees and April before anything is written', async () => {
    const { db } = getDb();
    expect(baseCurrency(db)).toBe('INR');
    expect(yearStartMonth(db)).toBe(4);
  });

  it('refuses a currency outside the list, and JPY, and makes no admin', async () => {
    for (const code of ['XYZ', 'JPY']) {
      const r = await setup({ ...login, baseCurrency: code, yearStart: '1' });
      expect(r.status).toBe(400);
      expect(r.data?.message).toBe('Choose a currency for totals from the list.');
    }
    const bad = await setup({ ...login, baseCurrency: 'USD', yearStart: '7' });
    expect(bad.status).toBe(400);
    expect(bad.data?.message).toBe('Choose January or April for the year start.');
    const { db } = getDb();
    expect(db.select().from(schema.users).all()).toHaveLength(0);
    expect(db.select().from(schema.instanceSettings).all()).toHaveLength(0);
  });

  it('writes the currency and the year start with the admin; the readers return them', async () => {
    const r = await setup({ ...login, baseCurrency: 'usd' });
    expect(r.status).toBe(303); // the redirect into the app
    const { db } = getDb();
    expect(db.select().from(schema.users).all()).toHaveLength(1);
    expect(baseCurrency(db)).toBe('USD');
    // No month posted: the currency's own default, January for dollars.
    expect(yearStartMonth(db)).toBe(1);
  });
});

// The same dollar instance, as its pages read it.
describe('after a dollar setup with a January year', () => {
  const admin = () => {
    const u = getDb().db.select().from(schema.users).get()!;
    return { id: u.id, username: u.username, role: u.role } as const;
  };

  it('every page is handed USD and January by the layout', async () => {
    const data = (await layoutLoad({
      locals: { user: admin() },
      request: new Request('http://localhost/'),
      cookies: { get: () => undefined },
      depends: () => {},
    } as never)) as { baseCurrency: string; yearStart: number; prefs: { numberSystem: string } };
    expect(data.baseCurrency).toBe('USD');
    expect(data.yearStart).toBe(1);
    // A dollar instance's first-run grouping is Western (SET1 RD2), not the rupee default.
    expect(data.prefs.numberSystem).toBe('western');
  });

  it("Reports' 'this year' runs from 1 January to 31 December, named plainly", async () => {
    const data = (await reportsLoad({
      locals: { user: admin() },
      url: new URL('http://localhost/reports?preset=thisFY'),
    } as never)) as { period: { from: string; to: string; label: string } };
    const year = today(systemClock()).year;
    expect(data.period.from).toBe(`${year}-01-01`);
    expect(data.period.to).toBe(`${year}-12-31`);
    expect(data.period.label).toBe('This year');
  });

  it("the Actual import makes its accounts in dollars and says so in the preview", async () => {
    const db = getDb();
    const budget = readActualExport(fs.readFileSync(SAMPLE));
    const preview = previewImport(db, admin().id, budget);
    expect(preview.currency).toBe('USD');
    await runImport(db, admin().id, budget, 'Sample-budget-export.zip', defaultChoices(preview));
    const made = db.db.select({ currency: schema.accounts.currency }).from(schema.accounts).all();
    expect(made.length).toBeGreaterThan(0);
    expect(new Set(made.map((a) => a.currency))).toEqual(new Set(['USD']));
  });
});
