/**
 * epf-eps.integration.test.ts — S5 RD16: an EPF
 * and its EPS. The EPS is its own account (counted at what was paid in, not markable) linked to its
 * EPF by `parent_account_id` (migration 0014). It is made with the EPF, sits in the EPF's section
 * right after it, stays out of the section's rate, and follows the EPF when shared (P0: a holder of
 * the EPF sees its EPS, a non-holder neither), closed, reopened and renamed. Driven through the
 * route actions and loads, like m8-sections-action.
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
const DB_PATH = path.join(os.tmpdir(), `miserly-epf-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin, createMember } from '../src/lib/server/auth/users';
import { seedStarterCategories } from '../src/lib/server/seed';
import { accountBalance } from '../src/lib/server/db/balances';
import { closeAccount, renameAccount, reopenAccount, UpcomingRowsError } from '../src/lib/server/accounts';
import { accountSummary, holdingMetrics } from '../src/lib/server/dashboard';
import { accountsVisibleTo } from '../src/lib/server/visibility';
import { shareAccount, unshareAccount } from '../src/lib/server/sharing';
import { createTransaction } from '../src/lib/server/transactions';
import { actions as accountActions } from '../src/routes/accounts/+page.server';
import { load as sectionLoad } from '../src/routes/sections/[type]/+page.server';

let alice: AuthedUser;
let bob: AuthedUser;
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
	bob = await createMember(db, { username: 'bob', displayName: 'Bob', tempPassword: 'bob-password-123' });
	await seedStarterCategories(db); // Salary, the category an EPF's and EPS's rows take
});
afterAll(() => {
	getDb().sqlite.close();
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('EPF with its EPS (S5 RD16)', () => {
	it('Add account makes the EPF and its EPS together, the EPS linked and named after it', async () => {
		await create(ev({ type: 'epf', name: 'EPF (Acme Tech)', currency: 'INR', invested: '1040000', currentValue: '1274100', openingDate: TODAY, childOpening: '149940', info_employer: 'Acme Tech' }));
		const epf = row('EPF (Acme Tech)');
		const eps = row('EPS of EPF (Acme Tech)');
		expect(epf.type).toBe('epf');
		expect(eps.type).toBe('eps');
		expect(eps.parentAccountId).toBe(epf.id);
		expect(eps.ownerId).toBe(alice.id);
		expect(accountBalance(getDb().sqlite, epf.id)).toBe(12_74_100_00);
		expect(accountBalance(getDb().sqlite, eps.id)).toBe(1_49_940_00);
		// Counted at what was paid in: no Update value, Invested = value.
		const m = await holdingMetrics(getDb(), alice.id, eps.id);
		expect(m!.markable).toBe(false);
		expect(m!.costBasisPaise).toBe(m!.currentValuePaise);
	});

	it('an EPS is never made on its own', async () => {
		const r = (await create(ev({ type: 'eps', name: 'Loose EPS', currency: 'INR', invested: '1000', openingDate: TODAY }))) as { status?: number };
		expect(r.status).toBe(400);
	});

	it('an EPS paid in with the employer as Salary stays at what was paid in', async () => {
		const eps = row('EPS of EPF (Acme Tech)');
		const salary = getDb().db.select().from(schema.categories).where(eq(schema.categories.name, 'Salary')).get();
		await createTransaction(getDb(), { userId: alice.id }, { accountId: eps.id, date: TODAY, amountPaise: 2_083_00, categoryId: salary?.id ?? null });
		const m = await holdingMetrics(getDb(), alice.id, eps.id);
		expect(m!.currentValuePaise).toBe(1_52_023_00);
		expect(salary).toBeDefined(); // seeded with the starter categories
		expect(m!.returnPaise).toBe(0); // Salary is money put in (C3)
	});

	it("sits in the EPF's section right after it; the section adds both; no EPS section", async () => {
		const groups = await accountSummary(getDb(), alice.id);
		const epfGroup = groups.find((g) => g.type === 'epf')!;
		expect(epfGroup.accounts.map((a) => [a.name, a.parentId !== null])).toEqual([
			['EPF (Acme Tech)', false],
			['EPS of EPF (Acme Tech)', true]
		]);
		expect(groups.some((g) => g.type === 'eps')).toBe(false);
		const page = (await sectionLoad({ locals: { user: me() }, params: { type: 'epf' }, url: new URL('http://localhost/sections/epf') } as never)) as {
			holdingKpi: { valuePaise: number };
		};
		expect(page.holdingKpi.valuePaise).toBe(12_74_100_00 + 1_52_023_00);
		await expect(sectionLoad({ locals: { user: me() }, params: { type: 'eps' }, url: new URL('http://localhost/sections/eps') } as never)).rejects.toMatchObject({ status: 404 });
	});

	it('P0: sharing the EPF shares its EPS; a non-holder sees neither; unsharing takes both away', async () => {
		const epf = row('EPF (Acme Tech)');
		const eps = row('EPS of EPF (Acme Tech)');
		expect(await accountsVisibleTo(getDb().db, bob.id)).not.toContain(eps.id);
		await shareAccount(getDb().db, { userId: alice.id }, epf.id, bob.id);
		const seen = await accountsVisibleTo(getDb().db, bob.id);
		expect(seen).toContain(epf.id);
		expect(seen).toContain(eps.id);
		await unshareAccount(getDb().db, { userId: alice.id }, eps.id, bob.id); // asked from the EPS tab
		const after = await accountsVisibleTo(getDb().db, bob.id);
		expect(after).not.toContain(epf.id);
		expect(after).not.toContain(eps.id);
	});

	it('renaming the EPF renames its EPS', async () => {
		const epf = row('EPF (Acme Tech)');
		await renameAccount(getDb(), epf.id, 'EPF (Acme)', alice.id);
		expect(row('EPS of EPF (Acme)').parentAccountId).toBe(epf.id);
	});

	it('the EPF closes only once its EPS is empty, then both close; reopening opens both', async () => {
		const epf = row('EPF (Acme)');
		const eps = row('EPS of EPF (Acme)');
		await expect(closeAccount(getDb(), epf.id)).rejects.toThrow(UpcomingRowsError);
		await expect(closeAccount(getDb(), epf.id)).rejects.toThrow(/EPS still holds money/);
		await closeAccount(getDb(), eps.id); // its own close (written off here; Pay and close in the app)
		await closeAccount(getDb(), epf.id);
		expect(row('EPF (Acme)').status).toBe('closed');
		expect(row('EPS of EPF (Acme)').status).toBe('closed');
		await reopenAccount(getDb(), epf.id, alice.id);
		expect(row('EPF (Acme)').status).toBe('open');
		expect(row('EPS of EPF (Acme)').status).toBe('open');
	});
});
