/**
 * visibility.test.ts — the M4 crown-jewel privacy proof (unit level).
 * ============================================================================
 * Seeds users A(admin)/B/C(member) and accounts A_private (owner A), A_shared
 * (owner A, B is a member), B_own (owner B), plus a soft-deleted account, and
 * asserts the single `visibleWhere` predicate (owned ∪ member-of, live only)
 * behaves exactly as the P0 privacy invariant requires — INCLUDING that the
 * admin role gets no special visibility.
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountsVisibleTo, isAccountVisibleTo } from '../src/lib/server/visibility';

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

function seed(): Db {
	const h = createDb(':memory:');
	handle = h;
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	const { db } = h;

	db.insert(schema.users)
		.values([
			{ id: 'A', displayName: 'Admin', username: 'a', role: 'admin' },
			{ id: 'B', displayName: 'Member B', username: 'b', role: 'member' },
			{ id: 'C', displayName: 'Member C', username: 'c', role: 'member' },
		])
		.run();

	db.insert(schema.accounts)
		.values([
			{
				id: 'A_private',
				ownerId: 'A',
				name: 'A private',
				type: 'bank',
				currency: 'INR',
				openingPaise: 0,
			},
			{
				id: 'A_shared',
				ownerId: 'A',
				name: 'A shared',
				type: 'bank',
				currency: 'INR',
				openingPaise: 0,
			},
			{
				id: 'B_own',
				ownerId: 'B',
				name: 'B own',
				type: 'bank',
				currency: 'INR',
				openingPaise: 0,
			},
			{
				id: 'A_deleted_shared',
				ownerId: 'A',
				name: 'A deleted (was shared with B)',
				type: 'bank',
				currency: 'INR',
				openingPaise: 0,
				deletedAt: '2020-01-01 00:00:00',
			},
		])
		.run();

	db.insert(schema.accountMembers)
		.values([
			{ accountId: 'A_shared', userId: 'B' },
			{ accountId: 'A_deleted_shared', userId: 'B' },
		])
		.run();

	return h;
}

describe('visibility: accountsVisibleTo', () => {
	it('A (owner) sees both A_private and A_shared', async () => {
		const { db } = seed();
		const ids = await accountsVisibleTo(db, 'A');
		expect(new Set(ids)).toEqual(new Set(['A_private', 'A_shared']));
	});

	it('B (member of A_shared, owner of B_own) sees exactly those two, not A_private', async () => {
		const { db } = seed();
		const ids = await accountsVisibleTo(db, 'B');
		expect(new Set(ids)).toEqual(new Set(['A_shared', 'B_own']));
	});

	it('C (no ownership, no membership anywhere) sees nothing', async () => {
		const { db } = seed();
		const ids = await accountsVisibleTo(db, 'C');
		expect(ids).toEqual([]);
	});

	it('a soft-deleted account drops out of the visible set, even for a member', async () => {
		const { db } = seed();
		const aIds = await accountsVisibleTo(db, 'A');
		const bIds = await accountsVisibleTo(db, 'B');
		expect(aIds).not.toContain('A_deleted_shared');
		expect(bIds).not.toContain('A_deleted_shared');
	});
});

describe('visibility: isAccountVisibleTo', () => {
	it('matches set membership: false for A_private, true for A_shared (viewer B)', async () => {
		const { db } = seed();
		expect(await isAccountVisibleTo(db, 'B', 'A_private')).toBe(false);
		expect(await isAccountVisibleTo(db, 'B', 'A_shared')).toBe(true);
	});

	it('ADMIN IS NOT PRIVILEGED: A cannot see B_own despite being the admin', async () => {
		const { db } = seed();
		expect(await isAccountVisibleTo(db, 'A', 'B_own')).toBe(false);
	});

	it('a non-existent account id is not visible to anyone', async () => {
		const { db } = seed();
		expect(await isAccountVisibleTo(db, 'A', 'does-not-exist')).toBe(false);
	});
});
