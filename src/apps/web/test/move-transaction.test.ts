/**
 * move-transaction.test.ts: All transactions' Account cell (as Actual's
 * All accounts register). A row moves to another account: balances follow, the category follows
 * Actual's rule (cleared into a holding; a transfer's sits on its spending leg), and the refusals
 * (value update, currency, a transfer's own other side, an account the actor can't see, a stale row).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountBalance } from '../src/lib/server/db/balances';
import {
	moveTransaction,
	MoveTransactionError,
	AccountNotFoundError,
	StaleEditError
} from '../src/lib/server/transactions';

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

let seq = 0;
function seed(): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db.insert(schema.users).values([
		{ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
		{ id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' }
	]).run();
	h.db.insert(schema.categoryGroups).values({ id: 'g', name: 'Food', kind: 'spending' }).run();
	h.db.insert(schema.categories).values({ id: 'c', groupId: 'g', name: 'Groceries' }).run();
	const acct = (id: string, type: string, currency = 'INR', ownerId = 'alice') =>
		h.db.insert(schema.accounts).values({ id, ownerId, name: id, type, currency, openingPaise: 0, openingDate: '2026-01-01' }).run();
	acct('hdfc', 'bank');
	acct('sbi', 'bank');
	acct('card', 'creditCard');
	acct('mf', 'mutualFunds');
	acct('usd', 'bank', 'USD');
	acct('bobs', 'bank', 'INR', 'bob');
	return h;
}
function tx(h: Db, id: string, accountId: string, amountPaise: number, opts: { categoryId?: string; kind?: 'ordinary' | 'valuationMark' } = {}) {
	h.db.insert(schema.transactions).values({ id, accountId, date: '2026-10-10', sequence: seq++, amountPaise, categoryId: opts.categoryId ?? null, kind: opts.kind ?? 'ordinary' }).run();
}
function link(h: Db, a: string, b: string) {
	h.db.update(schema.transactions).set({ transferPartnerId: b }).where(eq(schema.transactions.id, a)).run();
	h.db.update(schema.transactions).set({ transferPartnerId: a }).where(eq(schema.transactions.id, b)).run();
}
const row = (h: Db, id: string) => h.db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()!;
const move = (h: Db, id: string, to: string, who = 'alice') => moveTransaction(h, { userId: who }, id, to, row(h, id).updatedAt);

describe('moveTransaction', () => {
	it('moves a withdrawal: both balances follow, the category stays between spending accounts', async () => {
		const h = seed();
		tx(h, 's', 'hdfc', -500_00, { categoryId: 'c' });
		await move(h, 's', 'sbi');
		expect(row(h, 's').accountId).toBe('sbi');
		expect(row(h, 's').categoryId).toBe('c');
		expect(accountBalance(h.sqlite, 'hdfc')).toBe(0);
		expect(accountBalance(h.sqlite, 'sbi')).toBe(-500_00);
	});

	it('moves a deposit too, keeping its category in a holding (categorised rows on holdings count)', async () => {
		const h = seed();
		tx(h, 'd', 'hdfc', 900_00, { categoryId: 'c' });
		await move(h, 'd', 'mf');
		expect(row(h, 'd').accountId).toBe('mf');
		expect(row(h, 'd').categoryId).toBe('c');
	});

	it("moves a transfer's leg, keeping the category on whichever leg is now the spending side", async () => {
		const h = seed();
		tx(h, 'out', 'hdfc', -1_000_00, { categoryId: 'c' }); // bank → fund: the bank leg holds it
		tx(h, 'in', 'mf', 1_000_00);
		link(h, 'out', 'in');
		await move(h, 'out', 'card'); // card → fund: the card leg holds it
		expect(row(h, 'out').accountId).toBe('card');
		expect(row(h, 'out').categoryId).toBe('c');
		await move(h, 'in', 'sbi'); // card → bank: no category
		expect(row(h, 'out').categoryId).toBeNull();
		expect(row(h, 'in').categoryId).toBeNull();
	});

	it("refuses a value update, another currency, and a transfer's own other side", async () => {
		const h = seed();
		tx(h, 'm', 'mf', 100_00, { kind: 'valuationMark' });
		await expect(move(h, 'm', 'hdfc')).rejects.toBeInstanceOf(MoveTransactionError);
		tx(h, 's', 'hdfc', -100_00);
		await expect(move(h, 's', 'usd')).rejects.toThrow('Only to an account in INR');
		tx(h, 'out', 'hdfc', -1_00);
		tx(h, 'in', 'sbi', 1_00);
		link(h, 'out', 'in');
		await expect(move(h, 'out', 'sbi')).rejects.toBeInstanceOf(MoveTransactionError);
	});

	it("never moves a row into, or out of, an account the actor can't see (P0)", async () => {
		const h = seed();
		tx(h, 's', 'hdfc', -100_00);
		await expect(move(h, 's', 'bobs')).rejects.toBeInstanceOf(AccountNotFoundError);
		await expect(move(h, 's', 'sbi', 'bob')).rejects.toBeInstanceOf(AccountNotFoundError);
		expect(row(h, 's').accountId).toBe('hdfc');
	});

	it('refuses a row changed since the page loaded', async () => {
		const h = seed();
		tx(h, 's', 'hdfc', -100_00);
		await expect(moveTransaction(h, { userId: 'alice' }, 's', 'sbi', 'stale')).rejects.toBeInstanceOf(StaleEditError);
	});
});
