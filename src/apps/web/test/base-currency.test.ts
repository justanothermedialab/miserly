/**
 * base-currency.test.ts: everything reads the currency for totals and the year start chosen at
 * setup (MC1 RD2 amended, R1, H1). A dollar instance with a January year:
 * a rupee account at a rate, net worth in dollars, a report's "this year" from 1 January, PPF's
 * year still from 1 April. An instance with no setting reads rupees and April, as before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import * as schema from '../src/lib/server/db/schema';
import { createAccount } from '../src/lib/server/accounts';
import { parseRateToScaled, setRate, listRates, activeForeignCurrencies, loadRateTable } from '../src/lib/server/rates';
import { dashboardSummary } from '../src/lib/server/dashboard';
import { spendingByCategory } from '../src/lib/server/reports';
import { baseCurrency, yearStartMonth, getUserPrefs, INSTANCE_KEYS } from '../src/lib/server/settings';
import { resolvePeriod, presetLabel, presetHint } from '../src/lib/reports/period';
import { financialYearStart } from '../src/lib/modules';
import { boundMoney, DEFAULT_PREFS } from '../src/lib/format-context';
import { formatBaseApprox } from '../src/lib/format';
import { parseDate } from '@miserly/core';

let handle: Db | undefined;
afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

/** A fresh instance; `instance` writes the two setup choices as setup does. */
function seed(instance?: { base: string; year: string }): Db {
  const h = createDb(':memory:');
  handle = h;
  for (const stmt of allStatements()) h.sqlite.exec(stmt);
  h.db.insert(schema.users).values([{ id: 'u1', username: 'u1', displayName: 'U1', role: 'admin' }]).run();
  if (instance) {
    const updatedAt = new Date().toISOString();
    h.db
      .insert(schema.instanceSettings)
      .values([
        { key: INSTANCE_KEYS.baseCurrency, value: instance.base, updatedAt },
        { key: INSTANCE_KEYS.yearStart, value: instance.year, updatedAt },
      ])
      .run();
  }
  return h;
}

async function acct(h: Db, currency: string, openingPaise: number): Promise<string> {
  const a = await createAccount(h, {
    ownerId: 'u1',
    type: 'bank',
    name: `${currency} bank`,
    currency,
    openingPaise,
    openingDate: '2024-01-01',
  });
  return a.id;
}

describe('a dollar instance with a January year', () => {
  it('reads USD and January', () => {
    const h = seed({ base: 'USD', year: '1' });
    expect(baseCurrency(h.db)).toBe('USD');
    expect(yearStartMonth(h.db)).toBe(1);
  });

  it('values a rupee account at its rate; net worth is in dollars', async () => {
    const h = seed({ base: 'USD', year: '1' });
    await acct(h, 'USD', 1_000_00); // $1,000.00
    await acct(h, 'INR', 83_000_00); // ₹83,000.00

    // No INR rate yet: the rupee account is left out and named, never added 1:1.
    const before = await dashboardSummary(h, 'u1');
    expect(before.baseCurrency).toBe('USD');
    expect(before.netWorthPaise).toBe(1_000_00);
    expect(before.rateNeededCurrencies).toEqual(['INR']);

    // One rupee in dollars (a rate stays "one unit of X in base").
    setRate(h, 'INR', parseRateToScaled('0.012'));
    const after = await dashboardSummary(h, 'u1');
    expect(after.netWorthPaise).toBe(1_000_00 + 996_00); // 83,000 × 0.012 = $996
    expect(after.rateNeededCurrencies).toEqual([]);
    expect(loadRateTable(h.db).base).toBe('USD');
  });

  it('lists rupees as the currency needing a rate, and refuses a rate for the dollar', async () => {
    const h = seed({ base: 'USD', year: '1' });
    await acct(h, 'USD', 1_00);
    await acct(h, 'INR', 1_00);
    expect(await activeForeignCurrencies(h.db, 'u1')).toEqual(['INR']);
    expect(() => setRate(h, 'USD', parseRateToScaled('1'))).toThrow(/base currency/u);
    setRate(h, 'INR', parseRateToScaled('0.012'));
    expect(listRates(h.db).map((r) => r.currency)).toEqual(['INR']);
  });

  it("reports total in dollars", async () => {
    const h = seed({ base: 'USD', year: '1' });
    const r = await spendingByCategory(h, 'u1', { from: '2026-01-01', to: '2026-06-30' });
    expect(r.baseCurrency).toBe('USD');
  });

  it('a new member gets Western grouping by default (not the rupee default)', async () => {
    const h = seed({ base: 'USD', year: '1' });
    expect((await getUserPrefs(h.db, 'u1', null, baseCurrency(h.db))).numberSystem).toBe('western');
  });

  it("'this year' runs from 1 January; PPF's year still starts 1 April", () => {
    const today = parseDate('2026-06-10');
    const thisYear = resolvePeriod('thisFY', today, { yearStart: 1 });
    expect([thisYear.from, thisYear.to]).toEqual(['2026-01-01', '2026-12-31']);
    const lastYear = resolvePeriod('lastFY', today, { yearStart: 1 });
    expect([lastYear.from, lastYear.to]).toEqual(['2025-01-01', '2025-12-31']);
    expect(presetLabel('thisFY', 1)).toBe('This year');
    expect(presetHint('thisFY', 1)).toBeUndefined();
    // PPF's "Deposited this year" is the law's April-to-March year whatever the setting.
    expect(financialYearStart('2026-06-10')).toBe('2026-04-01');
    expect(financialYearStart('2026-02-10')).toBe('2025-04-01');
  });

  it('the formatter carries the dollar sign, including the "≈" line', () => {
    const m = boundMoney(DEFAULT_PREFS, 'USD');
    expect(m.money(1_234_56)).toBe('$1,234.56');
    expect(m.baseApprox(1_234_56)).toBe('≈ $1,234.56');
    expect(formatBaseApprox(1_234_56, { currency: 'USD' })).toBe('≈ $1,234.56');
  });
});

describe('an instance set up before the choice (no setting written)', () => {
  it('reads rupees and April, and its figures are as before', async () => {
    const h = seed();
    expect(baseCurrency(h.db)).toBe('INR');
    expect(yearStartMonth(h.db)).toBe(4);
    await acct(h, 'INR', 1_00_000_00);
    const s = await dashboardSummary(h, 'u1');
    expect(s.baseCurrency).toBe('INR');
    expect(s.netWorthPaise).toBe(1_00_000_00);
    const thisFY = resolvePeriod('thisFY', parseDate('2026-06-10'));
    expect([thisFY.from, thisFY.to]).toEqual(['2026-04-01', '2027-03-31']);
    expect(presetLabel('thisFY')).toBe('This financial year');
    expect(presetHint('thisFY')).toBe('April to March');
    expect(boundMoney(DEFAULT_PREFS).baseApprox(1_00)).toBe('≈ ₹1.00');
  });

  it('a stored value outside the list falls back to rupees', () => {
    const h = seed({ base: 'JPY', year: '9' });
    expect(baseCurrency(h.db)).toBe('INR');
    expect(yearStartMonth(h.db)).toBe(4);
  });
});
