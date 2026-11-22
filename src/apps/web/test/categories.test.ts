/**
 * categories.test.ts — F2 groups + categories.
 * ============================================================================
 * Covers group/category CRUD, the single `kindOf` mapping (and that moving a
 * category across groups changes its kind), hide (excluded from the tree but the
 * row survives), the ATOMIC category delete (throws without a reassignment
 * target when live transactions exist; re-points them when given one), and the
 * guarded group delete (refused while live categories remain).
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import {
	kindOf,
	createGroup,
	renameGroup,
	setGroupKind,
	deleteGroup,
	createCategory,
	renameCategory,
	moveCategory,
	hideCategory,
	deleteCategory,
	listCategoryTree,
	CategoryNameConflictError,
	GroupNotEmptyError,
	CategoryReassignRequiredError
} from '../src/lib/server/categories';

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

function seed(): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	h.db.insert(schema.users).values({ id: 'u1', username: 'u1', displayName: 'U1' }).run();
	h.db
		.insert(schema.accounts)
		.values({ id: 'a1', ownerId: 'u1', name: 'Acct', type: 'bank', currency: 'INR', openingPaise: 0 })
		.run();
	return h;
}

/** Insert a live transaction pointed at `categoryId`. */
function addTx(h: Db, categoryId: string | null, seqn: number): string {
	const id = randomUUID();
	h.db
		.insert(schema.transactions)
		.values({
			id,
			accountId: 'a1',
			date: '2024-01-01',
			sequence: seqn,
			amountPaise: -100_00,
			categoryId,
			kind: 'ordinary'
		})
		.run();
	return id;
}

describe('categories: group + category CRUD', () => {
	it('creates groups + categories and lists them as a tree', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Essentials', kind: 'spending' });
		await createCategory(h.db, { groupId: g.id, name: 'Rent', colour: '#E5484D' });
		await createCategory(h.db, { groupId: g.id, name: 'Groceries' });

		const tree = await listCategoryTree(h.db);
		expect(tree).toHaveLength(1);
		expect(tree[0]!.name).toBe('Essentials');
		expect(tree[0]!.categories.map((c) => c.name)).toEqual(['Rent', 'Groceries']);
	});

	it('rejects duplicate group names (normalized) among active groups', async () => {
		const h = seed();
		await createGroup(h.db, { name: 'Income', kind: 'income' });
		await expect(createGroup(h.db, { name: ' income ', kind: 'income' })).rejects.toBeInstanceOf(
			CategoryNameConflictError
		);
	});

	it('rejects duplicate category names within the same group', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Lifestyle', kind: 'spending' });
		await createCategory(h.db, { groupId: g.id, name: 'Travel' });
		await expect(createCategory(h.db, { groupId: g.id, name: 'travel' })).rejects.toBeInstanceOf(
			CategoryNameConflictError
		);
	});

	it('renames a group and a category', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Old', kind: 'neutral' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'CatOld' });
		await renameGroup(h.db, g.id, 'New');
		await renameCategory(h.db, c.id, 'CatNew');
		const tree = await listCategoryTree(h.db);
		expect(tree[0]!.name).toBe('New');
		expect(tree[0]!.categories[0]!.name).toBe('CatNew');
	});
});

describe('categories: kindOf + move', () => {
	it('kindOf returns the category’s group kind, and null for a bogus id', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Income', kind: 'income' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'Salary' });
		expect(await kindOf(h.db, c.id)).toBe('income');
		expect(await kindOf(h.db, 'nope')).toBeNull();
	});

	it('setGroupKind reclassifies every category under it', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Flexible', kind: 'spending' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'Misc' });
		expect(await kindOf(h.db, c.id)).toBe('spending');
		await setGroupKind(h.db, g.id, 'neutral');
		expect(await kindOf(h.db, c.id)).toBe('neutral');
	});

	it('moving a category across groups changes its kindOf', async () => {
		const h = seed();
		const income = await createGroup(h.db, { name: 'Income', kind: 'income' });
		const spending = await createGroup(h.db, { name: 'Spending', kind: 'spending' });
		const c = await createCategory(h.db, { groupId: income.id, name: 'Bonus' });
		expect(await kindOf(h.db, c.id)).toBe('income');
		await moveCategory(h.db, c.id, spending.id);
		expect(await kindOf(h.db, c.id)).toBe('spending');
	});
});

describe('categories: hide', () => {
	it('hide excludes from the default tree but keeps the row (and reappears with includeHidden)', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Grp', kind: 'spending' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'Hideme' });
		await hideCategory(h.db, c.id);

		const visible = await listCategoryTree(h.db);
		expect(visible[0]!.categories.map((x) => x.name)).not.toContain('Hideme');

		const withHidden = await listCategoryTree(h.db, { includeHidden: true });
		expect(withHidden[0]!.categories.map((x) => x.name)).toContain('Hideme');

		// The row itself is still present (not tombstoned).
		const row = h.db
			.select()
			.from(schema.categories)
			.where(and(eq(schema.categories.id, c.id), isNull(schema.categories.deletedAt)))
			.get();
		expect(row).toBeDefined();
		expect(row!.hidden).toBe(true);
	});
});

describe('categories: delete (atomic reassignment)', () => {
	it('throws without a reassign target when the category has live transactions', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Grp', kind: 'spending' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'Used' });
		addTx(h, c.id, 0);
		await expect(deleteCategory(h.db, c.id)).rejects.toBeInstanceOf(CategoryReassignRequiredError);
	});

	it('re-points live transactions to the target and tombstones the category, atomically', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Grp', kind: 'spending' });
		const from = await createCategory(h.db, { groupId: g.id, name: 'From' });
		const to = await createCategory(h.db, { groupId: g.id, name: 'To' });
		const txId = addTx(h, from.id, 0);

		await deleteCategory(h.db, from.id, to.id);

		// Transaction re-pointed.
		const tx = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, txId)).get();
		expect(tx!.categoryId).toBe(to.id);
		// Category gone (tombstoned) → out of the tree and kindOf null.
		expect(await kindOf(h.db, from.id)).toBeNull();
		const tree = await listCategoryTree(h.db);
		expect(tree[0]!.categories.map((c) => c.name)).toEqual(['To']);
	});

	it('reassigning to null (Uncategorized) nulls the transaction category', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Grp', kind: 'spending' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'Solo' });
		const txId = addTx(h, c.id, 0);
		await deleteCategory(h.db, c.id, null);
		const tx = h.db.select().from(schema.transactions).where(eq(schema.transactions.id, txId)).get();
		expect(tx!.categoryId).toBeNull();
	});

	it('clears any remembered category pointer on delete (referential-integrity cascade)', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Grp', kind: 'spending' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'Remembered' });
		// A payee that remembers this category for the user.
		h.db.insert(schema.payees).values({ id: 'p1', displayName: 'P', nameNormalized: 'p' }).run();
		h.db
			.insert(schema.userPayee)
			.values({ userId: 'u1', payeeId: 'p1', lastCategoryId: c.id })
			.run();

		await deleteCategory(h.db, c.id, null);

		const up = h.db
			.select()
			.from(schema.userPayee)
			.where(and(eq(schema.userPayee.userId, 'u1'), eq(schema.userPayee.payeeId, 'p1')))
			.get();
		expect(up!.lastCategoryId).toBeNull();
	});
});

describe('categories: group delete guard', () => {
	it('refuses to delete a group that still holds a live, non-hidden category', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'NonEmpty', kind: 'spending' });
		await createCategory(h.db, { groupId: g.id, name: 'Blocker' });
		await expect(deleteGroup(h.db, g.id)).rejects.toBeInstanceOf(GroupNotEmptyError);
	});

	it('deletes an empty group (soft-delete tombstone)', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'Empty', kind: 'spending' });
		await deleteGroup(h.db, g.id);
		const tree = await listCategoryTree(h.db, { includeHidden: true });
		expect(tree.find((x) => x.id === g.id)).toBeUndefined();
	});

	it('a hidden category does not block group delete (and is tombstoned with the group)', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'HiddenOnly', kind: 'spending' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'Ghost' });
		await hideCategory(h.db, c.id);
		await deleteGroup(h.db, g.id); // should NOT throw

		const groupRow = h.db
			.select()
			.from(schema.categoryGroups)
			.where(eq(schema.categoryGroups.id, g.id))
			.get();
		expect(groupRow!.deletedAt).not.toBeNull();
		const catRow = h.db
			.select()
			.from(schema.categories)
			.where(eq(schema.categories.id, c.id))
			.get();
		expect(catRow!.deletedAt).not.toBeNull();
	});

	it('refuses to delete a group whose HIDDEN category still has live transactions', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'HiddenWithTx', kind: 'spending' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'GhostSpend' });
		addTx(h, c.id, 0);
		await hideCategory(h.db, c.id);

		// Tombstoning the hidden category here would orphan its transaction onto
		// a deleted category with no reassignment prompt — must be refused.
		await expect(deleteGroup(h.db, g.id)).rejects.toBeInstanceOf(GroupNotEmptyError);
		const catRow = h.db.select().from(schema.categories).where(eq(schema.categories.id, c.id)).get();
		expect(catRow!.deletedAt).toBeNull(); // nothing changed
	});

	it('clears a remembered-category pointer at a hidden category tombstoned by group delete', async () => {
		const h = seed();
		const g = await createGroup(h.db, { name: 'HiddenRemembered', kind: 'spending' });
		const c = await createCategory(h.db, { groupId: g.id, name: 'GhostMemory' });
		await hideCategory(h.db, c.id);
		// A payee remembers the hidden (transaction-free) category.
		h.db.insert(schema.payees).values({ id: 'p9', displayName: 'P9', nameNormalized: 'p9' }).run();
		h.db.insert(schema.userPayee).values({ userId: 'u1', payeeId: 'p9', lastCategoryId: c.id }).run();

		await deleteGroup(h.db, g.id); // tombstones the hidden category…

		const up = h.db
			.select()
			.from(schema.userPayee)
			.where(and(eq(schema.userPayee.userId, 'u1'), eq(schema.userPayee.payeeId, 'p9')))
			.get();
		expect(up!.lastCategoryId).toBeNull(); // …and the cascade cleared the pointer
	});
});
