/**
 * nps.integration.test.ts: NPS as its own types ("separate
 * accounts"). Tier I and Tier II are two accounts made in Add account, both in one NPS section.
 * Tier I is locked in; Tier II, withdrawn in about 3 days, is available soon like a fund. Both are
 * in rupees whatever the base. Driven through the route actions and loads, like epf-eps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { formatDate, today, systemClock } from '@miserly/core';
import type { AuthedUser } from '../src/lib/server/auth/session';

const TODAY = formatDate(today(systemClock()));
const DB_PATH = path.join(os.tmpdir(), `miserly-nps-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { accountSummary, dashboardSummary } from '../src/lib/server/dashboard';
import { addAsOptions, guessAddAs } from '../src/lib/server/import/actual-import';
import { actions as accountActions } from '../src/routes/accounts/+page.server';
import { load as sectionLoad } from '../src/routes/sections/[type]/+page.server';

let alice: AuthedUser;
const me = (): AuthedUser => ({ id: alice.id, username: 'alice', role: 'admin' });
function ev(fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return { locals: { user: me() }, params: {}, request: new Request('http://localhost/', { method: 'POST', body }) } as never;
}
const row = (name: string) => getDb().db.select().from(schema.accounts).where(eq(schema.accounts.name, name)).get()!;
const create = accountActions.create as (arg: never) => Promise<unknown>;
const section = (type: string) =>
	sectionLoad({ locals: { user: me() }, params: { type }, url: new URL(`http://localhost/sections/${type}`) } as never);

beforeAll(async () => {
	alice = await createAdmin(getDb().db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
});
afterAll(() => {
	getDb().sqlite.close();
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('NPS Tier I and Tier II', () => {
	it('Add account makes each tier as its own account, in rupees, with its PRAN or note', async () => {
		await create(ev({ type: 'nps', name: 'NPS', invested: '300000', currentValue: '360000', openingDate: TODAY, info_pran: '110012345678' }));
		await create(ev({ type: 'npsTier2', name: 'NPS Tier II', invested: '50000', currentValue: '54000', openingDate: TODAY }));
		const t1 = row('NPS');
		const t2 = row('NPS Tier II');
		expect([t1.type, t2.type]).toEqual(['nps', 'npsTier2']);
		expect([t1.currency, t2.currency]).toEqual(['INR', 'INR']);
		expect(t1.infoJson).toBe(JSON.stringify({ pran: '110012345678' }));
		expect(t2.parentAccountId).toBeNull();
	});

	it('both sit in one NPS section; there is no Tier II section', async () => {
		const groups = await accountSummary(getDb(), alice.id);
		expect(groups.find((g) => g.type === 'nps')?.accounts.map((a) => a.name)).toEqual(['NPS', 'NPS Tier II']);
		expect(groups.some((g) => g.type === 'npsTier2')).toBe(false);
		const page = (await section('nps')) as { holdingKpi: { valuePaise: number } };
		expect(page.holdingKpi.valuePaise).toBe(3_60_000_00 + 54_000_00);
		await expect(section('npsTier2')).rejects.toMatchObject({ status: 404 });
	});

	it('Tier I counts as locked in, Tier II as available soon', async () => {
		const d = await dashboardSummary(getDb(), alice.id);
		const band = (k: string) => d.byLiquidity.find((s) => s.key === k)?.amountPaise ?? 0;
		expect(band('Illiquid')).toBe(3_60_000_00);
		expect(band('Semi')).toBe(54_000_00);
	});

	it('the Actual import guesses NPS from the name, before "fund"', () => {
		const off = (name: string) => guessAddAs({ name, offBudget: true } as never, 1_00_000_00);
		expect(off('NPS')).toBe('nps:0');
		expect(off('NPS - SBI Pension Fund')).toBe('nps:0');
		expect(off('National Pension System')).toBe('nps:0');
		expect(off('NPS Tier II')).toBe('npsTier2:0');
		expect(off('NPS Tier 2')).toBe('npsTier2:0');
		expect(off('HDFC Mid-cap fund')).toBe('mutualFunds:0');
	});

	it("the import's Add as ends with the India group, as Add account does (O31)", () => {
		expect(addAsOptions().filter((o) => o.group === 'India').map((o) => o.label)).toEqual([
			'PPF',
			'EPF',
			'Sovereign Gold Bond',
			'NPS Tier I',
			'NPS Tier II',
		]);
		expect(addAsOptions().at(-1)?.group).toBe('India');
	});

	it("the Actual import offers both tiers under Add as; Tier I's plain deposits count as money put in", () => {
		const opts = addAsOptions().filter((o) => o.type === 'nps' || o.type === 'npsTier2');
		expect(opts.map((o) => [o.label, o.depositsMoneyIn])).toEqual([
			['NPS Tier I', true],
			['NPS Tier II', false],
		]);
	});
});
