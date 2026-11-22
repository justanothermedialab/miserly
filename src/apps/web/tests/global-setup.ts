/**
 * global-setup.ts — seeds the e2e database ONCE before any Playwright test
 * runs (and before/independently of the `webServer` process — see e2e-env.ts).
 * Uses the real `users.ts` service functions (not raw SQL) for user creation,
 * so the seeded hashes/roles/flags are exactly what the app itself would
 * produce; accounts/membership are direct inserts (F1/H2 CRUD doesn't exist
 * yet at M4 — accounts are test-seeded per the milestone brief).
 *
 * Decision: `createMember` always sets `must_change_password = true` (H1).
 * The privacy e2e is not exercising the forced-password-change flow (that's
 * smoke-checked separately), so bob/carol are immediately given a known,
 * un-forced password via `changePassword` right after creation — this keeps
 * the privacy specs focused on visibility scoping rather than re-deriving the
 * change-password journey on every test.
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDb } from '../src/lib/server/db/client';
import { runMigrations } from '../src/lib/server/db/migrate';
import { createAdmin, createMember, changePassword } from '../src/lib/server/auth/users';
import * as schema from '../src/lib/server/db/schema';
import { E2E_DB_PATH } from './e2e-env';
import { SEED_USERS, SEED_ACCOUNTS } from './fixtures';

export default async function globalSetup(): Promise<void> {
	fs.mkdirSync(path.dirname(E2E_DB_PATH), { recursive: true });
	runMigrations(E2E_DB_PATH);

	const { sqlite, db } = createDb(E2E_DB_PATH);
	try {
		const alice = await createAdmin(db, {
			username: SEED_USERS.alice.username,
			displayName: 'Alice',
			password: SEED_USERS.alice.password,
		});

		const bob = await createMember(db, {
			username: SEED_USERS.bob.username,
			displayName: 'Bob',
			tempPassword: SEED_USERS.bob.password,
		});
		await changePassword(db, bob.id, SEED_USERS.bob.password);

		const carol = await createMember(db, {
			username: SEED_USERS.carol.username,
			displayName: 'Carol',
			tempPassword: SEED_USERS.carol.password,
		});
		await changePassword(db, carol.id, SEED_USERS.carol.password);

		db.insert(schema.accounts)
			.values([
				{
					id: SEED_ACCOUNTS.alicePrivate,
					ownerId: alice.id,
					name: 'Alice Private',
					type: 'bank',
					currency: 'INR',
					openingPaise: 0,
				},
				{
					id: SEED_ACCOUNTS.aliceShared,
					ownerId: alice.id,
					name: 'Alice Shared',
					type: 'bank',
					currency: 'INR',
					openingPaise: 0,
				},
				{
					id: SEED_ACCOUNTS.bobOwn,
					ownerId: bob.id,
					name: 'Bob Own',
					type: 'bank',
					currency: 'INR',
					openingPaise: 0,
				},
			])
			.run();

		db.insert(schema.accountMembers)
			.values({ accountId: SEED_ACCOUNTS.aliceShared, userId: bob.id })
			.run();
	} finally {
		sqlite.close();
	}
}
