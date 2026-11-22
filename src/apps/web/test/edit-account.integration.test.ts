/**
 * edit-account.integration.test.ts — the red team's route-level checks (2026-11-06).
 * Edit account reads as Add account (the notes): a loan's outstanding is typed as a positive amount
 * owed and stored negative, a holding's amount invested can't be negative, and a closed account
 * saves its name but never its opening. Close refuses while rows are dated later, before
 * Pay and close moves any money.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AuthedUser } from '../src/lib/server/auth/session';

const DB_PATH = path.join(os.tmpdir(), `miserly-edit-account-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import * as schema from '../src/lib/server/db/schema';
import { createAdmin } from '../src/lib/server/auth/users';
import { accountBalance } from '../src/lib/server/db/balances';
import { actions } from '../src/routes/accounts/[id]/+page.server';

let alice: AuthedUser;
const ids = { loan: randomUUID(), fund: randomUUID(), old: randomUUID(), bank: randomUUID(), dest: randomUUID() };

function ev(id: string, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const request = new Request('http://localhost/', { method: 'POST', body });
	return { locals: { user: alice }, params: { id }, request } as never;
}
type Result = { accountSaved?: boolean; closed?: boolean; status?: number; data?: { errors: Record<string, string> } };
const edit = (id: string, fields: Record<string, string>) => (actions.editAccount as (arg: never) => Promise<Result>)(ev(id, fields));
const close = (id: string, fields: Record<string, string>) => (actions.close as (arg: never) => Promise<Result>)(ev(id, fields));
const account = (id: string) => getDb().db.select().from(schema.accounts).all().find((a) => a.id === id)!;

beforeAll(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-06T06:00:00Z'));
	const { db } = getDb();
	const u = await createAdmin(db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
	alice = { id: u.id, username: 'alice', role: 'admin' } as AuthedUser;
	const base = { ownerId: alice.id, currency: 'INR', openingDate: '2024-01-01' } as const;
	db.insert(schema.accounts)
		.values([
			{ ...base, id: ids.loan, type: 'loan', name: 'Car', openingPaise: -5_00_000_00 },
			{ ...base, id: ids.fund, type: 'mutualFunds', name: 'Index', openingPaise: 1_00_000_00 },
			{ ...base, id: ids.old, type: 'bank', name: 'Old', openingPaise: 0, status: 'closed' },
			{ ...base, id: ids.bank, type: 'bank', name: 'HDFC', openingPaise: 1_00_000_00 },
			{ ...base, id: ids.dest, type: 'bank', name: 'SBI', openingPaise: 0 }
		])
		.run();
	db.insert(schema.transactions)
		.values({ id: randomUUID(), accountId: ids.bank, date: '2026-12-05', sequence: 1, amountPaise: -20_000_00, kind: 'ordinary' })
		.run();
});

afterAll(() => {
	vi.useRealTimers();
	getDb().sqlite.close();
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('Edit account reads as Add account', () => {
	it("takes a loan's outstanding as a positive amount owed and stores it negative", async () => {
		expect((await edit(ids.loan, { name: 'Car', outstanding: '4,80,000', openingDate: '2024-01-01' })).accountSaved).toBe(true);
		expect(account(ids.loan).openingPaise).toBe(-4_80_000_00);
		// Minus means in credit, as on Add account.
		await edit(ids.loan, { name: 'Car', outstanding: '-1000', openingDate: '2024-01-01' });
		expect(account(ids.loan).openingPaise).toBe(1_000_00);
	});

	it("refuses a negative amount invested on a holding", async () => {
		const r = await edit(ids.fund, { name: 'Index', opening: '-5000', openingDate: '2024-01-01' });
		expect(r.status).toBe(400);
		expect(r.data?.errors.opening).toBe('Amount cannot be negative');
		expect(account(ids.fund).openingPaise).toBe(1_00_000_00);
	});

	it('saves a closed account\'s name but never its opening', async () => {
		expect((await edit(ids.old, { name: 'Old SBI', opening: '15000', openingDate: '2024-01-01' })).accountSaved).toBe(true);
		expect(account(ids.old).name).toBe('Old SBI');
		expect(account(ids.old).openingPaise).toBe(0);
	});
});

describe('Close with a row dated later', () => {
	it('is refused before Pay and close moves any money', async () => {
		const r = await close(ids.bank, { toId: ids.dest, mode: 'move' });
		expect(r.status).toBe(400);
		expect(r.data?.errors._).toBe('This account has 1 upcoming row (5 Dec 2026). Delete or move it first.');
		expect(accountBalance(getDb().sqlite, ids.dest)).toBe(0);
		expect(account(ids.bank).status).toBe('open');
	});
});
