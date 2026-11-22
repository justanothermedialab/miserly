/**
 * auth.test.ts — the M4 auth-core unit proof (password / session / users / lockout).
 * ============================================================================
 * In-memory db, schema applied via `allStatements()` (includes migration 0001,
 * so the auth columns exist). Mirrors the differential-suite pattern in
 * test/persistence.integration.test.ts: relative imports only, no SvelteKit
 * plugin (vitest.config.ts runs `test/**` under plain node).
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/server/db/client';
import { allStatements } from '../src/lib/server/db/migrate';
import type { Db } from '../src/lib/server/db/client';
import * as schema from '../src/lib/server/db/schema';
import { hashPassword, verifyPassword, needsRehash } from '../src/lib/server/auth/password';
import {
	createSession,
	validateSession,
	invalidateSession,
	invalidateOtherSessions,
	hashToken,
} from '../src/lib/server/auth/session';
import type { SessionConfig } from '../src/lib/server/auth/session';
import {
	adminExists,
	createAdmin,
	createMember,
	verifyCredentials,
	mustChangePassword,
	changePassword,
	recordFailure,
	isLockedOut,
	resetFailures,
} from '../src/lib/server/auth/users';
import { LOCKOUT } from '../src/lib/server/config';

const DAY_MS = 1000 * 60 * 60 * 24;
const SESSION_CFG: SessionConfig = { absoluteMs: 30 * DAY_MS, idleMs: 7 * DAY_MS };

let handle: Db | undefined;
afterEach(() => {
	handle?.sqlite.close();
	handle = undefined;
});

function freshDb(): Db {
	const h = createDb(':memory:');
	for (const stmt of allStatements()) h.sqlite.exec(stmt);
	handle = h;
	return h;
}

describe('password', () => {
	it('hashes and verifies: correct password true, wrong password false', async () => {
		const hash = await hashPassword('correct-horse-battery');
		expect(await verifyPassword(hash, 'correct-horse-battery')).toBe(true);
		expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
	});

	it('needsRehash is false for a fresh hash, true for a hand-written weak hash', async () => {
		const fresh = await hashPassword('correct-horse-battery');
		expect(needsRehash(fresh)).toBe(false);

		const weak = '$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHQ$aGFzaGVkdmFsdWU';
		expect(needsRehash(weak)).toBe(true);
	});
});

describe('session', () => {
	it('stores only the HASH of the token; validateSession resolves a good token, null for a bad one', async () => {
		const { db } = freshDb();
		db.insert(schema.users).values({ id: 'u1', displayName: 'U', username: 'u1', role: 'member' }).run();

		const issued = await createSession(db, 'u1', SESSION_CFG, new Date('2024-01-01T00:00:00Z'));
		expect(issued.sessionId).toBe(hashToken(issued.token));

		const row = db.select().from(schema.sessions).where(eq(schema.sessions.id, issued.sessionId)).get();
		expect(row).toBeDefined();
		expect(row?.id).not.toBe(issued.token); // the RAW token is never persisted

		const user = await validateSession(db, issued.token, SESSION_CFG, new Date('2024-01-01T00:00:00Z'));
		expect(user?.id).toBe('u1');

		expect(await validateSession(db, 'this-token-does-not-exist', SESSION_CFG)).toBeNull();
	});

	it('absolute expiry: a session is dead after absoluteMs, even if otherwise unused', async () => {
		const { db } = freshDb();
		db.insert(schema.users).values({ id: 'u1', displayName: 'U' }).run();
		const t0 = new Date('2024-01-01T00:00:00Z');
		const issued = await createSession(db, 'u1', SESSION_CFG, t0);

		const past31Days = new Date(t0.getTime() + 31 * DAY_MS);
		expect(await validateSession(db, issued.token, SESSION_CFG, past31Days)).toBeNull();
	});

	it('idle expiry: a session is dead after idleMs of inactivity (fail-closed)', async () => {
		const { db } = freshDb();
		db.insert(schema.users).values({ id: 'u1', displayName: 'U' }).run();
		const t0 = new Date('2024-01-01T00:00:00Z');
		const issued = await createSession(db, 'u1', SESSION_CFG, t0);

		const past8Days = new Date(t0.getTime() + 8 * DAY_MS);
		expect(await validateSession(db, issued.token, SESSION_CFG, past8Days)).toBeNull();
	});

	it('a valid mid-window validate slides last_used_at forward', async () => {
		const { db } = freshDb();
		db.insert(schema.users).values({ id: 'u1', displayName: 'U' }).run();
		const t0 = new Date('2024-01-01T00:00:00Z');
		const issued = await createSession(db, 'u1', SESSION_CFG, t0);

		const oneDayLater = new Date(t0.getTime() + DAY_MS);
		const user = await validateSession(db, issued.token, SESSION_CFG, oneDayLater);
		expect(user).not.toBeNull();

		const row = db.select().from(schema.sessions).where(eq(schema.sessions.id, issued.sessionId)).get();
		expect(row?.lastUsedAt).toBe(oneDayLater.toISOString());
	});

	it('two createSession calls for the same user yield DIFFERENT ids (rotation)', async () => {
		const { db } = freshDb();
		db.insert(schema.users).values({ id: 'u1', displayName: 'U' }).run();
		const a = await createSession(db, 'u1', SESSION_CFG);
		const b = await createSession(db, 'u1', SESSION_CFG);
		expect(a.sessionId).not.toBe(b.sessionId);
	});

	it('invalidateSession hard-deletes the session (logout)', async () => {
		const { db } = freshDb();
		db.insert(schema.users).values({ id: 'u1', displayName: 'U' }).run();
		const issued = await createSession(db, 'u1', SESSION_CFG);
		await invalidateSession(db, issued.token);
		expect(await validateSession(db, issued.token, SESSION_CFG)).toBeNull();
	});

	it('invalidateOtherSessions deletes sibling sessions but keeps the current token', async () => {
		const { db } = freshDb();
		db.insert(schema.users).values({ id: 'u1', displayName: 'U' }).run();
		const a = await createSession(db, 'u1', SESSION_CFG);
		const b = await createSession(db, 'u1', SESSION_CFG);

		await invalidateOtherSessions(db, 'u1', a.token);

		const rows = db.select().from(schema.sessions).where(eq(schema.sessions.userId, 'u1')).all();
		expect(rows.map((r) => r.id)).toEqual([a.sessionId]);
		expect(await validateSession(db, a.token, SESSION_CFG)).not.toBeNull();
		expect(await validateSession(db, b.token, SESSION_CFG)).toBeNull();
	});
});

describe('users service', () => {
	it('createAdmin then adminExists is true; a second createAdmin throws', async () => {
		const { db } = freshDb();
		await createAdmin(db, { username: 'Alice', displayName: 'Alice', password: 'password123' });
		expect(await adminExists(db)).toBe(true);

		await expect(
			createAdmin(db, { username: 'someone-else', displayName: 'Other', password: 'password123' }),
		).rejects.toThrow();
	});

	it('verifyCredentials: good password succeeds, bad password fails, unknown username fails identically', async () => {
		const { db } = freshDb();
		await createAdmin(db, { username: 'Alice', displayName: 'Alice', password: 'password123' });

		const ok = await verifyCredentials(db, 'alice', 'password123');
		expect(ok?.username).toBe('alice');

		expect(await verifyCredentials(db, 'alice', 'wrong-password')).toBeNull();
		expect(await verifyCredentials(db, 'no-such-user', 'whatever-password')).toBeNull();
	});

	it('username match is case-insensitive: "Alice" logs in as "alice"', async () => {
		const { db } = freshDb();
		await createAdmin(db, { username: 'Alice', displayName: 'Alice', password: 'password123' });
		const user = await verifyCredentials(db, 'ALICE', 'password123');
		expect(user?.username).toBe('alice');
	});

	it('createMember rejects a duplicate username', async () => {
		const { db } = freshDb();
		await createMember(db, { username: 'bob', displayName: 'Bob', tempPassword: 'temp-pw-1' });
		await expect(
			createMember(db, { username: 'Bob', displayName: 'Bob 2', tempPassword: 'temp-pw-2' }),
		).rejects.toThrow('That username is taken');
	});

	it('changePassword clears must_change_password and the new password verifies', async () => {
		const { db } = freshDb();
		const member = await createMember(db, {
			username: 'bob',
			displayName: 'Bob',
			tempPassword: 'temp-pw-1',
		});
		expect(await mustChangePassword(db, member.id)).toBe(true);

		await changePassword(db, member.id, 'new-strong-password');
		expect(await mustChangePassword(db, member.id)).toBe(false);
		expect(await verifyCredentials(db, 'bob', 'new-strong-password')).not.toBeNull();
		expect(await verifyCredentials(db, 'bob', 'temp-pw-1')).toBeNull();
	});
});

describe('lockout', () => {
	it('locks out after maxAttempts failures within the window; a reset (success) clears it', () => {
		const username = 'lockout-target';
		for (let i = 0; i < LOCKOUT.maxAttempts; i++) recordFailure(username);
		expect(isLockedOut(username)).toBe(true);

		resetFailures(username);
		expect(isLockedOut(username)).toBe(false);
	});

	it('fewer than maxAttempts failures does not lock out', () => {
		const username = 'not-locked-out';
		for (let i = 0; i < LOCKOUT.maxAttempts - 1; i++) recordFailure(username);
		expect(isLockedOut(username)).toBe(false);
	});
});
