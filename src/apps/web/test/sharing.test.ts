/**
 * sharing.test.ts — H2 per-account sharing (owner-controlled grants) + its P0.
 * ============================================================================
 * Proves the sharing service mutates ONLY the visible set (via account_members)
 * and never the visibility predicate: an owner shares → the member gains full
 * visibility; a non-owner cannot manage membership; a caller who can't see the
 * account gets the same 404 as a bogus id (no existence leak); un-share is a
 * tombstone that revokes access immediately; a re-share revives it.
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountsVisibleTo, isAccountVisibleTo } from '../src/lib/server/visibility';
import {
	shareAccount,
	unshareAccount,
	listAccountMembers,
	NotAccountOwnerError,
	InvalidShareTargetError,
} from '../src/lib/server/sharing';
import { AccountNotFoundError } from '../src/lib/server/transactions';

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
			{ id: 'A', displayName: 'Owner A', username: 'a', role: 'admin' },
			{ id: 'B', displayName: 'Member B', username: 'b', role: 'member' },
			{ id: 'C', displayName: 'Member C', username: 'c', role: 'member' },
			{ id: 'D', displayName: 'Gone D', username: 'd', role: 'member', deletedAt: '2020-01-01 00:00:00' },
		])
		.run();

	db.insert(schema.accounts)
		.values([
			{ id: 'A_acct', ownerId: 'A', name: 'A pool', type: 'bank', currency: 'INR', openingPaise: 0 },
			{ id: 'B_acct', ownerId: 'B', name: 'B own', type: 'bank', currency: 'INR', openingPaise: 0 },
		])
		.run();

	return h;
}

describe('shareAccount', () => {
	it('owner shares → the member gains full visibility of the account', async () => {
		const { db } = seed();
		expect(await isAccountVisibleTo(db, 'B', 'A_acct')).toBe(false);

		await shareAccount(db, { userId: 'A' }, 'A_acct', 'B');

		expect(await isAccountVisibleTo(db, 'B', 'A_acct')).toBe(true);
		expect(await accountsVisibleTo(db, 'B')).toEqual(expect.arrayContaining(['A_acct', 'B_acct']));
	});

	it('a non-owner member CANNOT share the account (owner-only)', async () => {
		const { db } = seed();
		await shareAccount(db, { userId: 'A' }, 'A_acct', 'B'); // B is now a member
		// B (a member, not the owner) tries to add C — rejected.
		await expect(shareAccount(db, { userId: 'B' }, 'A_acct', 'C')).rejects.toBeInstanceOf(
			NotAccountOwnerError,
		);
		expect(await isAccountVisibleTo(db, 'C', 'A_acct')).toBe(false);
	});

	it('a caller who cannot see the account gets a 404 (no existence leak)', async () => {
		const { db } = seed();
		// C can't see A_acct at all → same AccountNotFoundError as a bogus id.
		await expect(shareAccount(db, { userId: 'C' }, 'A_acct', 'B')).rejects.toBeInstanceOf(
			AccountNotFoundError,
		);
		await expect(shareAccount(db, { userId: 'C' }, 'no-such-acct', 'B')).rejects.toBeInstanceOf(
			AccountNotFoundError,
		);
	});

	it('sharing to the owner is a no-op; sharing to an inactive user is rejected', async () => {
		const { db } = seed();
		await shareAccount(db, { userId: 'A' }, 'A_acct', 'A'); // no-op, no throw
		const holders = await listAccountMembers(db, 'A', 'A_acct');
		expect(holders.filter((h) => !h.isOwner)).toHaveLength(0);

		await expect(shareAccount(db, { userId: 'A' }, 'A_acct', 'D')).rejects.toBeInstanceOf(
			InvalidShareTargetError,
		);
	});

	it('sharing twice is idempotent (one live grant)', async () => {
		const { db } = seed();
		await shareAccount(db, { userId: 'A' }, 'A_acct', 'B');
		await shareAccount(db, { userId: 'A' }, 'A_acct', 'B');
		const holders = await listAccountMembers(db, 'A', 'A_acct');
		expect(holders.filter((h) => h.userId === 'B')).toHaveLength(1);
	});
});

describe('unshareAccount', () => {
	it('tombstones the grant → the member loses access immediately', async () => {
		const { db } = seed();
		await shareAccount(db, { userId: 'A' }, 'A_acct', 'B');
		expect(await isAccountVisibleTo(db, 'B', 'A_acct')).toBe(true);

		await unshareAccount(db, { userId: 'A' }, 'A_acct', 'B');
		expect(await isAccountVisibleTo(db, 'B', 'A_acct')).toBe(false);

		// The row is tombstoned, not hard-deleted (sync-ready).
		const row = db
			.select()
			.from(schema.accountMembers)
			.where(eqPair('A_acct', 'B'))
			.get();
		expect(row?.deletedAt).not.toBeNull();
	});

	it('a re-share revives the tombstoned grant', async () => {
		const { db } = seed();
		await shareAccount(db, { userId: 'A' }, 'A_acct', 'B');
		await unshareAccount(db, { userId: 'A' }, 'A_acct', 'B');
		await shareAccount(db, { userId: 'A' }, 'A_acct', 'B');
		expect(await isAccountVisibleTo(db, 'B', 'A_acct')).toBe(true);
	});

	it('a non-owner cannot unshare', async () => {
		const { db } = seed();
		await shareAccount(db, { userId: 'A' }, 'A_acct', 'B');
		await expect(unshareAccount(db, { userId: 'B' }, 'A_acct', 'B')).rejects.toBeInstanceOf(
			NotAccountOwnerError,
		);
	});
});

describe('listAccountMembers', () => {
	it('lists owner + members for a holder; 404s for a non-holder', async () => {
		const { db } = seed();
		await shareAccount(db, { userId: 'A' }, 'A_acct', 'B');

		const holders = await listAccountMembers(db, 'B', 'A_acct');
		expect(holders.find((h) => h.isOwner)?.userId).toBe('A');
		expect(holders.find((h) => h.userId === 'B')?.isOwner).toBe(false);

		await expect(listAccountMembers(db, 'C', 'A_acct')).rejects.toBeInstanceOf(AccountNotFoundError);
	});
});

// Local helper: the (account_id, user_id) equality for a membership row.
function eqPair(accountId: string, userId: string) {
	return and(
		eq(schema.accountMembers.accountId, accountId),
		eq(schema.accountMembers.userId, userId),
	);
}
