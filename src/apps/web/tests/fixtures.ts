/**
 * fixtures.ts — the single source of truth for e2e seed identities, shared by
 * `tests/global-setup.ts` (which creates them) and the spec files (which sign
 * in as them). Known passwords so the specs can drive the real `/signin` form.
 */

export const SEED_USERS = {
	alice: { username: 'alice', password: 'alice-password-123', role: 'admin' as const },
	bob: { username: 'bob', password: 'bob-password-123', role: 'member' as const },
	carol: { username: 'carol', password: 'carol-password-123', role: 'member' as const },
} as const;

export const SEED_ACCOUNTS = {
	/** Owned by alice, private (no members) — bob/carol must never see it. */
	alicePrivate: 'alice-private',
	/** Owned by alice, bob added as a member — bob CAN see it. */
	aliceShared: 'alice-shared',
	/** Owned by bob, no members — proves the admin (alice) is not privileged. */
	bobOwn: 'bob-own',
} as const;
