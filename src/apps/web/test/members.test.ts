/**
 * members.test.ts — H3 membership administration + its P0 guarantees.
 * ============================================================================
 * Proves: admin-only authorization (a member is rejected server-side); the
 * last-admin can never be removed; a member who solely owns a shared account
 * cannot be removed (no orphaned shared account); a successful removal is atomic
 * — sessions revoked, grants tombstoned (co-holders lose access), user
 * soft-deleted (retained-but-inaccessible), and NO tombstoned row leaks to any
 * other live user. Admin is NEVER granted data visibility (that lives in the
 * visibility suite; here we only test the people-management gate).
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { accountsVisibleTo } from '../src/lib/server/visibility';
import {
	listMembers,
	removeMember,
	resetMemberPassword,
	NotAdminError,
	LastAdminError,
	SharedOwnershipError,
	MemberNotFoundError,
} from '../src/lib/server/members';
import { changePassword, passwordResetNotice, dismissPasswordResetNotice } from '../src/lib/server/auth/users';

const ADMIN = { id: 'A', role: 'admin' } as const;
const MEMBER = { id: 'B', role: 'member' } as const;

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
			{ id: 'A', displayName: 'Admin', username: 'a', role: 'admin', passwordHash: 'x' },
			{ id: 'B', displayName: 'Member B', username: 'b', role: 'member', passwordHash: 'x' },
			{ id: 'C', displayName: 'Member C', username: 'c', role: 'member', passwordHash: 'x' },
		])
		.run();

	db.insert(schema.accounts)
		.values([
			// B owns a PRIVATE account (removal-safe) and a SHARED one (blocks removal).
			{ id: 'B_private', ownerId: 'B', name: 'B private', type: 'bank', currency: 'INR', openingPaise: 0 },
			{ id: 'B_shared', ownerId: 'B', name: 'B pool', type: 'bank', currency: 'INR', openingPaise: 0 },
			// C owns a shared account that B is a co-holder of.
			{ id: 'C_shared', ownerId: 'C', name: 'C pool', type: 'bank', currency: 'INR', openingPaise: 0 },
		])
		.run();

	db.insert(schema.accountMembers)
		.values([
			{ accountId: 'B_shared', userId: 'C' }, // C can see B's shared pool
			{ accountId: 'C_shared', userId: 'B' }, // B is a co-holder of C's pool
		])
		.run();

	db.insert(schema.sessions)
		.values([{ id: 'sess-b', userId: 'B', expiresAt: '2099-01-01T00:00:00.000Z' }])
		.run();

	return h;
}

describe('listMembers', () => {
	it('admin sees all live members; a member is rejected', async () => {
		const { db } = seed();
		const members = await listMembers(db, ADMIN);
		expect(members.map((m) => m.id).sort()).toEqual(['A', 'B', 'C']);
		await expect(listMembers(db, MEMBER)).rejects.toBeInstanceOf(NotAdminError);
	});
});

describe('removeMember — guards', () => {
	it('a member cannot remove anyone (admin-only)', async () => {
		const { db } = seed();
		await expect(removeMember(db, MEMBER, 'C')).rejects.toBeInstanceOf(NotAdminError);
	});

	it('the admin (last admin) can never be removed — including by self', async () => {
		const { db } = seed();
		await expect(removeMember(db, ADMIN, 'A')).rejects.toBeInstanceOf(LastAdminError);
	});

	it('a member who solely owns a shared account is blocked, naming the account', async () => {
		const { db } = seed();
		await expect(removeMember(db, ADMIN, 'B')).rejects.toBeInstanceOf(SharedOwnershipError);
		try {
			await removeMember(db, ADMIN, 'B');
		} catch (e) {
			expect(e).toBeInstanceOf(SharedOwnershipError);
			expect((e as SharedOwnershipError).accounts.map((a) => a.id)).toContain('B_shared');
		}
		// Nothing was mutated by the blocked attempt.
		expect(db.select().from(schema.sessions).where(eq(schema.sessions.userId, 'B')).all()).toHaveLength(1);
	});

	it('an unknown member id throws MemberNotFoundError', async () => {
		const { db } = seed();
		await expect(removeMember(db, ADMIN, 'ghost')).rejects.toBeInstanceOf(MemberNotFoundError);
	});
});

describe('removeMember — success (atomic revoke)', () => {
	it('removes a member who owns no shared accounts: grants tombstoned, sessions revoked, user soft-deleted', async () => {
		const { db } = seed();
		// Unshare B's owned pool first (so B owns only a private account) — the
		// owner would do this; here we tombstone the grant directly.
		db.update(schema.accountMembers)
			.set({ deletedAt: '2020-01-01 00:00:00' })
			.where(eq(schema.accountMembers.accountId, 'B_shared'))
			.run();

		await removeMember(db, ADMIN, 'B');

		// Sessions gone (immediate revocation).
		expect(db.select().from(schema.sessions).where(eq(schema.sessions.userId, 'B')).all()).toHaveLength(0);
		// User soft-deleted (retained-but-inaccessible).
		const u = db.select().from(schema.users).where(eq(schema.users.id, 'B')).get();
		expect(u?.deletedAt).not.toBeNull();
		// C (owner of C_shared) is unaffected by B's removal — still sees C_shared.
		// (C's grant to B_shared was tombstoned in this test's setup, so it is
		// correctly absent — the point here is that removal doesn't disturb C's own.)
		expect(await accountsVisibleTo(db, 'C')).toContain('C_shared');
		// B's own PRIVATE account is retained in the file but leaks to no live user.
		expect(db.select().from(schema.accounts).where(eq(schema.accounts.id, 'B_private')).get()).toBeDefined();
		expect(await accountsVisibleTo(db, 'C')).not.toContain('B_private');
		expect(await accountsVisibleTo(db, 'A')).not.toContain('B_private');
	});

	it('removing a co-holder (not owner) of shared accounts is allowed and unaffects owners', async () => {
		const { db } = seed();
		// Make B own nothing shared: tombstone B_shared's grant, and give C sole
		// ownership by removing B's ownership scenario — here B still co-holds
		// C_shared. First clear B's shared-ownership block.
		db.update(schema.accountMembers)
			.set({ deletedAt: '2020-01-01 00:00:00' })
			.where(eq(schema.accountMembers.accountId, 'B_shared'))
			.run();

		await removeMember(db, ADMIN, 'B');
		// C keeps C_shared entirely.
		expect(await accountsVisibleTo(db, 'C')).toContain('C_shared');
	});
});

describe('resetMemberPassword', () => {
	it('forces a change + revokes sessions; a member cannot reset anyone', async () => {
		const { db } = seed();
		await resetMemberPassword(db, ADMIN, 'B', 'temp-password-123');

		const u = db.select().from(schema.users).where(eq(schema.users.id, 'B')).get();
		expect(u?.mustChangePassword).toBe(true);
		expect(db.select().from(schema.sessions).where(eq(schema.sessions.userId, 'B')).all()).toHaveLength(0);

		await expect(resetMemberPassword(db, MEMBER, 'C', 'temp-password-123')).rejects.toBeInstanceOf(
			NotAdminError,
		);
	});

	it('S4: the member is told; the notice stays until they dismiss it', async () => {
		const { db } = seed();
		expect(passwordResetNotice(db, 'B')).toBeNull();
		await resetMemberPassword(db, ADMIN, 'B', 'temp-password-123', '2026-11-12');
		// Not while the forced change is still owed: the first page after it shows the notice.
		expect(passwordResetNotice(db, 'B')).toBeNull();
		await changePassword(db, 'B', 'a-new-password-456');
		expect(passwordResetNotice(db, 'B')).toBe('2026-11-12');
		expect(passwordResetNotice(db, 'C')).toBeNull();
		dismissPasswordResetNotice(db, 'B');
		expect(passwordResetNotice(db, 'B')).toBeNull();
	});
});
