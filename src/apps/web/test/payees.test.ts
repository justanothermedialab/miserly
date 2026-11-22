/**
 * payees.test.ts — F3 payee identity + CRUD + viewer-scoped query.
 * ============================================================================
 * Covers the plain CRUD against the identity and integrity core:
 *   - resolvePayee reuses on a normalized match (un-hiding a hidden match) and
 *     creates otherwise;
 *   - renamePayee collision throws PayeeNameConflictError (route offers merge);
 *   - mergePayees re-points transactions + folds account_payee / user_payee
 *     (dedup composite PK; the target's remembered category wins) atomically;
 *   - clearRememberedCategory nulls the pointer;
 *   - payeeAutocomplete is viewer-scoped (a payee on a non-visible account is
 *     NOT returned) and excludes hidden;
 *   - listPayeesWithStats' "last used" is the latest LIVE visible ledger date,
 *     not the entry wall-clock time (REL-13).
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import {
	resolvePayee,
	mergePayees,
	clearRememberedCategory,
	renamePayee,
	listPayeesFor,
	listPayeesWithStats,
	payeeAutocomplete,
	rememberedCategoryFor,
	createPayeeFor,
	isPayeeVisibleTo,
	PayeeNameConflictError
} from '../src/lib/server/payees';
import { capturePayees } from '../src/lib/server/transactions';

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

function seed(): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db
		.insert(schema.users)
		.values([
			{ id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin' },
			{ id: 'bob', username: 'bob', displayName: 'Bob', role: 'member' }
		])
		.run();
	h.db
		.insert(schema.accounts)
		.values([
			{ id: 'aliceAcct', ownerId: 'alice', name: 'A', type: 'bank', currency: 'INR', openingPaise: 0 },
			{ id: 'bobAcct', ownerId: 'bob', name: 'B', type: 'bank', currency: 'INR', openingPaise: 0 }
		])
		.run();
	// Categories referenced by user_payee.last_category_id (FK is ON).
	h.db.insert(schema.categoryGroups).values({ id: 'g1', name: 'G1', kind: 'spending' }).run();
	h.db
		.insert(schema.categories)
		.values([
			{ id: 'catTarget', groupId: 'g1', name: 'Target' },
			{ id: 'catLoser', groupId: 'g1', name: 'Loser' },
			{ id: 'catX', groupId: 'g1', name: 'X' },
			{ id: 'catY', groupId: 'g1', name: 'Y' }
		])
		.run();
	return h;
}

describe('payees: resolvePayee (identity)', () => {
	it('reuses an existing payee on a normalized-name match', async () => {
		const h = seed();
		const first = await resolvePayee(h.db, 'Amazon');
		const again = await resolvePayee(h.db, '  amazon ');
		expect(again.created).toBe(false);
		expect(again.id).toBe(first.id);
	});

	it('creates a new payee for a genuinely new name', async () => {
		const h = seed();
		const a = await resolvePayee(h.db, 'Reliance');
		const b = await resolvePayee(h.db, 'Flipkart');
		expect(a.created).toBe(true);
		expect(b.created).toBe(true);
		expect(a.id).not.toBe(b.id);
	});

});

describe('payees: renamePayee', () => {
	it('renames when the new name is free', async () => {
		const h = seed();
		const p = await resolvePayee(h.db, 'Amzn');
		await renamePayee(h.db, p.id, 'Amazon India');
		const row = h.db.select().from(schema.payees).where(eq(schema.payees.id, p.id)).get();
		expect(row!.displayName).toBe('Amazon India');
		expect(row!.nameNormalized).toBe('amazon india');
	});

	it('throws PayeeNameConflictError (with the conflicting id) on a collision', async () => {
		const h = seed();
		const target = await resolvePayee(h.db, 'Amazon');
		const other = await resolvePayee(h.db, 'Amzn');
		try {
			await renamePayee(h.db, other.id, 'amazon');
			throw new Error('expected a conflict');
		} catch (err) {
			expect(err).toBeInstanceOf(PayeeNameConflictError);
			expect((err as PayeeNameConflictError).conflictingId).toBe(target.id);
		}
	});

	it('allows a casing-only rename of the same payee', async () => {
		const h = seed();
		const p = await resolvePayee(h.db, 'amazon');
		await renamePayee(h.db, p.id, 'AMAZON'); // same normalized id → allowed
		const row = h.db.select().from(schema.payees).where(eq(schema.payees.id, p.id)).get();
		expect(row!.displayName).toBe('AMAZON');
	});
});

describe('payees: mergePayees (atomic fold)', () => {
	it('re-points transactions, folds projections (target category wins), removes losers', async () => {
		const h = seed();
		const target = await resolvePayee(h.db, 'Amazon');
		const loser = await resolvePayee(h.db, 'Amazon.in');

		// A transaction on the loser.
		h.db
			.insert(schema.transactions)
			.values({
				id: 'tx1',
				accountId: 'aliceAcct',
				date: '2024-01-01',
				sequence: 0,
				amountPaise: -500_00,
				payeeId: loser.id,
				kind: 'ordinary'
			})
			.run();

		// account_payee: both point at aliceAcct → must dedup to one row on target.
		h.db.insert(schema.accountPayee).values([
			{ accountId: 'aliceAcct', payeeId: target.id, lastUsedAt: '2024-01-01T00:00:00Z' },
			{ accountId: 'aliceAcct', payeeId: loser.id, lastUsedAt: '2024-06-01T00:00:00Z' }
		]).run();

		// user_payee: target already remembers a category → target wins on merge.
		h.db.insert(schema.userPayee).values([
			{ userId: 'alice', payeeId: target.id, lastCategoryId: 'catTarget', lastUsedAt: '2024-01-01T00:00:00Z' },
			{ userId: 'alice', payeeId: loser.id, lastCategoryId: 'catLoser', lastUsedAt: '2024-06-01T00:00:00Z' }
		]).run();

		await mergePayees(h.db, target.id, [loser.id]);

		// Transaction now points at the target.
		const tx = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, 'tx1')).get();
		expect(tx!.payeeId).toBe(target.id);

		// Loser payee is gone.
		const loserRow = h.db.select().from(schema.payees).where(eq(schema.payees.id, loser.id)).get();
		expect(loserRow).toBeUndefined();

		// account_payee folded to a single target row with the later recency.
		const ap = h.db.select().from(schema.accountPayee).all();
		expect(ap).toHaveLength(1);
		expect(ap[0]!.payeeId).toBe(target.id);
		expect(ap[0]!.lastUsedAt).toBe('2024-06-01T00:00:00Z');

		// user_payee folded; the TARGET's remembered category wins.
		const up = h.db.select().from(schema.userPayee).all();
		expect(up).toHaveLength(1);
		expect(up[0]!.lastCategoryId).toBe('catTarget');
	});
});

describe('payees: clearRememberedCategory', () => {
	it('nulls every user_payee pointer at the given category', async () => {
		const h = seed();
		const p = await resolvePayee(h.db, 'Payee');
		h.db.insert(schema.userPayee).values({ userId: 'alice', payeeId: p.id, lastCategoryId: 'catX' }).run();
		await clearRememberedCategory(h.db, 'catX');
		const up = h.db.select().from(schema.userPayee).all();
		expect(up[0]!.lastCategoryId).toBeNull();
	});
});

describe('payees: rememberedCategoryFor', () => {
	it('reads the per-user remembered category (null when none)', async () => {
		const h = seed();
		const p = await resolvePayee(h.db, 'Payee');
		expect(await rememberedCategoryFor(h.db, 'alice', p.id)).toBeNull();
		h.db.insert(schema.userPayee).values({ userId: 'alice', payeeId: p.id, lastCategoryId: 'catY' }).run();
		expect(await rememberedCategoryFor(h.db, 'alice', p.id)).toBe('catY');
	});
});

describe('payees: listPayeesFor + autocomplete (viewer-scoped)', () => {
	it('lists only payees used on a visible account; a stored hidden flag is ignored', async () => {
		const h = seed();
		const onAlice = await resolvePayee(h.db, 'AliceShop');
		const onBob = await resolvePayee(h.db, 'BobShop');
		const hiddenOnAlice = await resolvePayee(h.db, 'HiddenShop');
		h.db.insert(schema.accountPayee).values([
			{ accountId: 'aliceAcct', payeeId: onAlice.id },
			{ accountId: 'bobAcct', payeeId: onBob.id },
			{ accountId: 'aliceAcct', payeeId: hiddenOnAlice.id }
		]).run();
		h.db.update(schema.payees).set({ hidden: true }).where(eq(schema.payees.id, hiddenOnAlice.id)).run(); // stored before Hide went

		const forAlice = await listPayeesFor(h.db, 'alice');
		expect(new Set(forAlice.map((p) => p.id))).toEqual(new Set([onAlice.id, hiddenOnAlice.id]));
	});

	it('autocomplete is viewer-scoped: a payee on a non-visible account is not returned', async () => {
		const h = seed();
		const onAlice = await resolvePayee(h.db, 'Zomato');
		const onBob = await resolvePayee(h.db, 'Zepto');
		h.db.insert(schema.accountPayee).values([
			{ accountId: 'aliceAcct', payeeId: onAlice.id },
			{ accountId: 'bobAcct', payeeId: onBob.id }
		]).run();

		const aliceResults = await payeeAutocomplete(h.db, 'alice', 'Z');
		const ids = aliceResults.map((r) => r.id);
		expect(ids).toContain(onAlice.id);
		expect(ids).not.toContain(onBob.id); // Bob's account is not visible to Alice
	});

	it('autocomplete ignores a stored hidden flag and ranks by recency (nulls last)', async () => {
		const h = seed();
		const recent = await resolvePayee(h.db, 'RecentMart');
		const older = await resolvePayee(h.db, 'OlderMart');
		const never = await resolvePayee(h.db, 'NeverMart');
		const hidden = await resolvePayee(h.db, 'HiddenMart');
		h.db.insert(schema.accountPayee).values([
			{ accountId: 'aliceAcct', payeeId: recent.id, lastUsedAt: '2024-06-01T00:00:00Z' },
			{ accountId: 'aliceAcct', payeeId: older.id, lastUsedAt: '2024-01-01T00:00:00Z' },
			{ accountId: 'aliceAcct', payeeId: never.id, lastUsedAt: null },
			{ accountId: 'aliceAcct', payeeId: hidden.id, lastUsedAt: '2024-12-01T00:00:00Z' }
		]).run();
		h.db.update(schema.payees).set({ hidden: true }).where(eq(schema.payees.id, hidden.id)).run(); // stored before Hide went

		const results = await payeeAutocomplete(h.db, 'alice', 'Mart');
		// recency desc, nulls last:
		expect(results.map((r) => r.id)).toEqual([hidden.id, recent.id, older.id, never.id]);
	});
});

describe('payees: listPayeesWithStats (REL-13 last used)', () => {
	it('last used = latest live transaction date on a visible account, not entry time', async () => {
		const h = seed();
		const shop = await resolvePayee(h.db, 'Shop');
		// Entry recency says "today" — the list must ignore it.
		h.db.insert(schema.accountPayee).values([
			{ accountId: 'aliceAcct', payeeId: shop.id, lastUsedAt: '2026-10-02T09:00:00Z' },
			{ accountId: 'bobAcct', payeeId: shop.id, lastUsedAt: '2026-10-02T09:00:00Z' }
		]).run();
		const tx = (id: string, accountId: string, date: string, deletedAt: string | null = null) => ({
			id, accountId, date, sequence: 0, amountPaise: -100_00, payeeId: shop.id, kind: 'ordinary' as const, deletedAt
		});
		h.db.insert(schema.transactions).values([
			tx('t1', 'aliceAcct', '2024-03-05'), // back-dated, live → the answer
			tx('t2', 'aliceAcct', '2024-05-01', '2026-10-02T09:00:00Z'), // later but deleted
			tx('t3', 'bobAcct', '2024-09-09') // later but not visible to alice
		]).run();

		const [row] = await listPayeesWithStats(h.db, 'alice');
		expect(row?.id).toBe(shop.id);
		expect(row?.lastUsedAt).toBe('2024-03-05');
		expect(row?.txnCount).toBe(1);
	});

	it('last used is null for a payee with no live visible transactions', async () => {
		const h = seed();
		const idle = await resolvePayee(h.db, 'Idle');
		h.db.insert(schema.accountPayee).values({ accountId: 'aliceAcct', payeeId: idle.id, lastUsedAt: '2026-10-02T09:00:00Z' }).run();
		const [row] = await listPayeesWithStats(h.db, 'alice');
		expect(row?.lastUsedAt).toBeNull();
		expect(row?.txnCount).toBe(0);
	});
});

describe('payees: createPayeeFor (F3 RD7, the New payee row)', () => {
	it('lands in the creator list with 0 transactions and its default category, and in capture', async () => {
		const h = seed();
		const id = await createPayeeFor(h.db, 'alice', '  Swiggy ', 'catX');
		const stats = await listPayeesWithStats(h.db, 'alice');
		expect(stats.map((p) => [p.displayName, p.txnCount, p.rememberedCategoryId])).toEqual([['Swiggy', 0, 'catX']]);
		expect(await isPayeeVisibleTo(h.db, 'alice', id)).toBe(true);
		expect((await capturePayees(h.db, 'alice')).map((p) => [p.id, p.rememberedCategoryId])).toEqual([[id, 'catX']]);
	});

	it('is invisible to another member (P0)', async () => {
		const h = seed();
		const id = await createPayeeFor(h.db, 'alice', 'Swiggy', null);
		expect(await listPayeesFor(h.db, 'bob')).toEqual([]);
		expect(await isPayeeVisibleTo(h.db, 'bob', id)).toBe(false);
	});

	it('refuses a name the viewer already has, pointing at it', async () => {
		const h = seed();
		const p = await resolvePayee(h.db, 'Amazon');
		h.db.insert(schema.accountPayee).values({ accountId: 'aliceAcct', payeeId: p.id }).run();
		await expect(createPayeeFor(h.db, 'alice', 'amazon', null)).rejects.toMatchObject({ conflictingId: p.id });
		h.db.update(schema.payees).set({ hidden: true }).where(eq(schema.payees.id, p.id)).run(); // stored before Hide went
		await expect(createPayeeFor(h.db, 'alice', 'AMAZON', null)).rejects.toThrow('Amazon is already in your payees.');
		const own = await createPayeeFor(h.db, 'alice', 'Swiggy', null);
		await expect(createPayeeFor(h.db, 'alice', 'swiggy', null)).rejects.toBeInstanceOf(PayeeNameConflictError);
		expect(own).toBeTruthy();
	});

	it('a name only another member uses privately answers the same, changes nothing of theirs, and stays out of the list', async () => {
		const h = seed();
		const bobs = await resolvePayee(h.db, 'Secret Clinic');
		h.db.insert(schema.accountPayee).values({ accountId: 'bobAcct', payeeId: bobs.id }).run();
		await expect(createPayeeFor(h.db, 'alice', 'secret clinic', null)).resolves.toBe(bobs.id);
		expect(h.db.select().from(schema.payees).where(eq(schema.payees.id, bobs.id)).get()!.displayName).toBe('Secret Clinic');
		expect(await listPayeesFor(h.db, 'alice')).toEqual([]);
	});
});
