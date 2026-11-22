/**
 * session.ts — server-side session lifecycle (the H1 owned-auth core).
 * ============================================================================
 * D8 / H1: authentication is SERVER-SIDE sessions (not JWT) — revocable, simple,
 * the DB is right there. The security-decisive rules encoded here:
 *
 *  1. The cookie carries a high-entropy OPAQUE token (32 CSPRNG bytes). The DB
 *     stores only its SHA-256 (`sessions.id`), so a DB read alone can NEVER
 *     impersonate a user (token-stored-unhashed would equal account takeover).
 *  2. A session row is created FRESH on every login (`createSession`), so the id
 *     is never a pre-login value — anti-fixation by construction. "Rotate on
 *     login" = a new row each login.
 *  3. Expiry is checked FAIL-CLOSED at the boundary against BOTH `expires_at`
 *     (absolute lifetime) AND `last_used_at + idleMs` (idle window). An expired
 *     session is deleted and treated as absent. A session exactly at its bound is
 *     expired (>= / >, never <=).
 *  4. Logout hard-deletes the row (immediate revocation). Password-change deletes
 *     the user's OTHER sessions (`invalidateOtherSessions`).
 *
 * R8 async-service convention: the public service functions return Promises even
 * though better-sqlite3 is synchronous, so the exact same call shape works
 * in-process (Electron) and remote (hosted). The pure crypto helpers below are
 * sync (they touch no DB). `now` is injectable so expiry is testable without
 * real time passing (mirrors the engine's injected Clock).
 * ============================================================================
 */
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';

type AppDb = Db['db'];

/** Session lifetimes (ms). Concrete values come from the app config (config.ts). */
export interface SessionConfig {
  /** Absolute lifetime: a session dies this long after creation regardless of use. */
  readonly absoluteMs: number;
  /** Idle window: a session dies this long after its last use. */
  readonly idleMs: number;
}

/** The minimal identity the auth gate attaches to `locals` for visibility scoping. */
export interface AuthedUser {
  readonly id: string;
  readonly username: string;
  readonly role: 'admin' | 'member';
}

/** A freshly issued session — `token` is the RAW value to put in the cookie. */
export interface IssuedSession {
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

/** 32 CSPRNG bytes as a URL-safe string — the opaque token handed to the client. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 (hex) of the token — the value stored in `sessions.id`. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Create a fresh session for `userId` (rotation / anti-fixation: always a new
 * row). Returns the RAW token for the cookie; only its hash is persisted.
 */
export async function createSession(
  db: AppDb,
  userId: string,
  cfg: SessionConfig,
  now: Date = new Date(),
): Promise<IssuedSession> {
  const token = generateSessionToken();
  const sessionId = hashToken(token);
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + cfg.absoluteMs).toISOString();

  db.insert(schema.sessions)
    .values({ id: sessionId, userId, expiresAt, lastUsedAt: nowIso })
    .run();

  return { token, sessionId, expiresAt };
}

/**
 * Resolve a raw cookie token to the authed user, or `null` if the token is
 * unknown/expired. Fail-closed: an absolute- OR idle-expired session is deleted
 * and treated as absent; a live session has its `last_used_at` touched (sliding
 * idle window). Also null if the underlying user is missing/soft-deleted.
 */
export async function validateSession(
  db: AppDb,
  token: string,
  cfg: SessionConfig,
  now: Date = new Date(),
): Promise<AuthedUser | null> {
  const sessionId = hashToken(token);
  const session = db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.deletedAt)))
    .get();
  if (!session) return null;

  const nowMs = now.getTime();
  const absoluteDead = nowMs >= Date.parse(session.expiresAt);
  const idleDead = nowMs - Date.parse(session.lastUsedAt) > cfg.idleMs;
  if (absoluteDead || idleDead) {
    db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
    return null;
  }

  const user = db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      role: schema.users.role,
    })
    .from(schema.users)
    .where(and(eq(schema.users.id, session.userId), isNull(schema.users.deletedAt)))
    .get();
  if (!user) return null;

  // Slide the idle window forward on successful use.
  db.update(schema.sessions)
    .set({ lastUsedAt: now.toISOString() })
    .where(eq(schema.sessions.id, sessionId))
    .run();

  return user;
}

/** Log out: hard-delete the session behind this raw token (immediate revocation). */
export async function invalidateSession(db: AppDb, token: string): Promise<void> {
  db.delete(schema.sessions).where(eq(schema.sessions.id, hashToken(token))).run();
}

/**
 * Invalidate all of a user's sessions EXCEPT the one behind `keepToken` — used on
 * password change (H1: changing your password logs out your OTHER sessions).
 */
export async function invalidateOtherSessions(
  db: AppDb,
  userId: string,
  keepToken: string,
): Promise<void> {
  db.delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, hashToken(keepToken))))
    .run();
}
