/**
 * india-types-currency.integration.test.ts: the Indian schemes are held in rupees whatever the
 * currency for totals. On a dollar instance, Add account opens
 * PPF, EPF (with its EPS) and SGB in INR, so PPF's ₹1.5 lakh a year is counted in rupees; any other
 * type still opens in the base. Driven through the route action, like epf-eps.
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
const DB_PATH = path.join(os.tmpdir(), `miserly-india-ccy-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { INSTANCE_KEYS } from '../src/lib/server/settings';
import { actions as accountActions } from '../src/routes/accounts/+page.server';

let alice: AuthedUser;
const me = (): AuthedUser => ({ id: alice.id, username: 'alice', role: 'admin' });
function ev(fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return { locals: { user: me() }, params: {}, request: new Request('http://localhost/', { method: 'POST', body }) } as never;
}
const row = (name: string) => getDb().db.select().from(schema.accounts).where(eq(schema.accounts.name, name)).get()!;
const create = accountActions.create as (arg: never) => Promise<unknown>;

beforeAll(async () => {
	const { db } = getDb();
	alice = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
	const updatedAt = new Date().toISOString();
	db.insert(schema.instanceSettings)
		.values([
			{ key: INSTANCE_KEYS.baseCurrency, value: 'USD', updatedAt },
			{ key: INSTANCE_KEYS.yearStart, value: '1', updatedAt },
		])
		.run();
});
afterAll(() => {
	getDb().sqlite.close();
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('Indian schemes open in rupees on a dollar instance', () => {
	it('PPF opens in INR, whether the form sends the base or nothing', async () => {
		await create(ev({ type: 'ppf', name: 'PPF sent USD', currency: 'USD', invested: '150000', openingDate: TODAY }));
		await create(ev({ type: 'ppf', name: 'PPF sent none', invested: '150000', openingDate: TODAY }));
		expect(row('PPF sent USD').currency).toBe('INR');
		expect(row('PPF sent none').currency).toBe('INR');
	});

	it('EPF and its EPS open in INR', async () => {
		await create(ev({ type: 'epf', name: 'EPF (Acme)', currency: 'USD', invested: '100000', openingDate: TODAY, childOpening: '20000' }));
		expect(row('EPF (Acme)').currency).toBe('INR');
		expect(row('EPS of EPF (Acme)').currency).toBe('INR');
	});

	it('a Sovereign Gold Bond opens in INR', async () => {
		await create(ev({ type: 'sgb', name: 'SGB 2020', currency: 'USD', invested: '50000', openingDate: TODAY }));
		expect(row('SGB 2020').currency).toBe('INR');
	});

	it('NPS Tier I and Tier II open in INR', async () => {
		await create(ev({ type: 'nps', name: 'NPS', currency: 'USD', invested: '300000', openingDate: TODAY }));
		await create(ev({ type: 'npsTier2', name: 'NPS Tier II', currency: 'USD', invested: '50000', openingDate: TODAY }));
		expect(row('NPS').currency).toBe('INR');
		expect(row('NPS Tier II').currency).toBe('INR');
	});

	it('any other type still opens in the base, or the currency picked', async () => {
		await create(ev({ type: 'bank', name: 'Chase', opening: '100', openingDate: TODAY }));
		await create(ev({ type: 'mutualFunds', name: 'Vanguard', currency: 'EUR', invested: '1000', openingDate: TODAY }));
		expect(row('Chase').currency).toBe('USD');
		expect(row('Vanguard').currency).toBe('EUR');
	});
});
