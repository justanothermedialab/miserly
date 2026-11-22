/**
 * users.ts — user service (H1): admin bootstrap, member creation, credential
 * verification, password change, and a simple per-process login-lockout.
 * ============================================================================
 * R8 async-service convention: every exported DB-touching function is `async`
 * (even though better-sqlite3 is sync underneath) so route code has one calling
 * shape whether the db is local (Electron) or remote (hosted, future).
 *
 * Usernames are normalized (`trim().toLowerCase()`) before storage/lookup —
 * `users.username`'s unique index then gives case-insensitive uniqueness for
 * free (schema.ts comment). `verifyCredentials` never reveals whether a
 * username exists (H1 failure case: user-enumeration leak) — a miss still
 * performs a dummy Argon2 verify so the timing is uniform.
 * ============================================================================
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import { hashPassword, verifyPassword, needsRehash } from './password';
import type { AuthedUser } from './session';
import { LOCKOUT } from '../config';
import { INSTANCE_KEYS } from '../settings';

type AppDb = Db['db'];

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export interface CreateAdminInput {
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
  /**
   * The instance's two setup choices (MC1 RD2 amended, R1), written in the same transaction
   * as the admin so a failed setup leaves neither. Absent (older callers, tests) writes no row and
   * the readers fall back to rupees and April.
   */
  readonly instance?: { readonly baseCurrency: string; readonly yearStartMonth: 1 | 4 };
}

export interface CreateMemberInput {
  readonly username: string;
  readonly displayName: string;
  readonly tempPassword: string;
}

/** Any live (non-tombstoned) row with `role = 'admin'`. */
export async function adminExists(db: AppDb): Promise<boolean> {
  const row = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.role, 'admin'), isNull(schema.users.deletedAt)))
    .get();
  return row !== undefined;
}

/** FIRST-RUN only — throws if an admin already exists (exactly one Circle, one admin). */
export async function createAdmin(db: AppDb, input: CreateAdminInput): Promise<AuthedUser> {
  const id = randomUUID();
  const username = normalizeUsername(input.username);
  // Hash first, then check and insert with nothing awaited between them: two setups sent together
  // both passed a check made before the hash and both inserted.
  const passwordHash = await hashPassword(input.password);
  db.transaction((tx) => {
    const existing = tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'admin'), isNull(schema.users.deletedAt)))
      .get();
    if (existing) throw new Error(ADMIN_EXISTS);
    tx.insert(schema.users)
      .values({
        id,
        username,
        displayName: input.displayName,
        passwordHash,
        role: 'admin',
        mustChangePassword: false,
      })
      .run();
    if (input.instance) {
      const updatedAt = new Date().toISOString();
      tx.insert(schema.instanceSettings)
        .values([
          { key: INSTANCE_KEYS.baseCurrency, value: input.instance.baseCurrency, updatedAt },
          { key: INSTANCE_KEYS.yearStart, value: String(input.instance.yearStartMonth), updatedAt },
        ])
        .run();
    }
  });
  return { id, username, role: 'admin' };
}

export const ADMIN_EXISTS = 'An admin has already been set up';

/**
 * Admin action: create a member login with a temp password (`must_change_password
 * = true`). A minimal surface only — full member management is H3/M11.
 */
export async function createMember(db: AppDb, input: CreateMemberInput): Promise<AuthedUser> {
  const id = randomUUID();
  const username = normalizeUsername(input.username);
  const passwordHash = await hashPassword(input.tempPassword);
  try {
    db.insert(schema.users)
      .values({
        id,
        username,
        displayName: input.displayName,
        passwordHash,
        role: 'member',
        mustChangePassword: true,
      })
      .run();
  } catch {
    throw new Error('That username is taken');
  }
  return { id, username, role: 'member' };
}

// A throwaway hash to verify against on a username miss, so failure timing does
// not distinguish "no such user" from "wrong password" (anti-enumeration).
// Computed once, lazily, and cached as a resolved promise thereafter.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword('miserly-anti-enumeration-dummy-password');
  return dummyHash;
}

/**
 * Verify username+password. Returns the `AuthedUser` on success, `null` on any
 * failure (bad username OR bad password — indistinguishable to the caller).
 * Transparently re-hashes on success if the stored hash's params are stale.
 */
export async function verifyCredentials(
  db: AppDb,
  username: string,
  password: string,
): Promise<AuthedUser | null> {
  const normalized = normalizeUsername(username);
  const row = db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.username, normalized), isNull(schema.users.deletedAt)))
    .get();

  if (!row || row.passwordHash === null) {
    await verifyPassword(await getDummyHash(), password); // uniform timing
    return null;
  }

  const ok = await verifyPassword(row.passwordHash, password);
  if (!ok) return null;

  if (needsRehash(row.passwordHash)) {
    const rehashed = await hashPassword(password);
    db.update(schema.users)
      .set({ passwordHash: rehashed, updatedAt: new Date().toISOString() })
      .where(eq(schema.users.id, row.id))
      .run();
  }

  return { id: row.id, username: row.username, role: row.role };
}

export async function mustChangePassword(db: AppDb, userId: string): Promise<boolean> {
  const row = db
    .select({ mustChangePassword: schema.users.mustChangePassword })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  return row?.mustChangePassword ?? false;
}

/** Set a new password and clear the forced-change flag. Caller invalidates other sessions. */
export async function changePassword(db: AppDb, userId: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  db.update(schema.users)
    .set({ passwordHash, mustChangePassword: false, updatedAt: new Date().toISOString() })
    .where(eq(schema.users.id, userId))
    .run();
}

/**
 * The day the admin reset this person's password, while the notice is still owed (S4): once the
 * forced change is done and until they dismiss it. Null otherwise.
 */
export function passwordResetNotice(db: AppDb, userId: string): string | null {
  const row = db
    .select({ at: schema.users.passwordResetAt, forced: schema.users.mustChangePassword })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  return row && !row.forced ? (row.at ?? null) : null;
}

/** The member dismissed the reset notice. */
export function dismissPasswordResetNotice(db: AppDb, userId: string): void {
  db.update(schema.users).set({ passwordResetAt: null }).where(eq(schema.users.id, userId)).run();
}

// ── Login lockout ────────────────────────────────────────────────────────
// A SIMPLE in-memory, per-process counter (MVP). NOT durable across restarts
// or shared across multiple app instances — a documented limitation, not an
// oversight; a persistent store is later work if ever needed.
interface FailureRecord {
  count: number;
  windowStart: number;
}
const failuresByUsername = new Map<string, FailureRecord>();

/**
 * Count a sign-in try BEFORE its password is checked, and say whether it may go ahead. Counting
 * when the check finished let every try sent at the same moment through; now
 * the eleventh try inside the window is refused however the tries are timed. A successful sign-in
 * clears the count (`resetFailures`).
 */
export function takeAttempt(username: string): 'go' | 'last' | 'refused' {
  if (isLockedOut(username)) return 'refused';
  return recordFailure(username) >= LOCKOUT.maxAttempts ? 'last' : 'go';
}

/** Usernames tracked at most; past it, finished windows go first, then the oldest name. */
const MAX_TRACKED = 10_000;

/** Record a failed login attempt for `username` (normalized); returns the count in the window. */
export function recordFailure(username: string): number {
  const key = normalizeUsername(username);
  const now = Date.now();
  const existing = failuresByUsername.get(key);
  if (!existing || now - existing.windowStart > LOCKOUT.windowMs) {
    failuresByUsername.delete(key);
    // Capped (S13): random usernames sent one after another grew the map without end.
    if (failuresByUsername.size >= MAX_TRACKED) {
      for (const [k, r] of failuresByUsername) if (now - r.windowStart > LOCKOUT.windowMs) failuresByUsername.delete(k);
      while (failuresByUsername.size >= MAX_TRACKED) {
        failuresByUsername.delete(failuresByUsername.keys().next().value!);
      }
    }
    failuresByUsername.set(key, { count: 1, windowStart: now });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

/** How many usernames the lockout is tracking (for the cap's test). */
export function trackedFailureCount(): number {
  return failuresByUsername.size;
}

/** True if `username` has hit `LOCKOUT.maxAttempts` within the current window. */
export function isLockedOut(username: string): boolean {
  const key = normalizeUsername(username);
  const existing = failuresByUsername.get(key);
  if (!existing) return false;
  if (Date.now() - existing.windowStart > LOCKOUT.windowMs) {
    failuresByUsername.delete(key);
    return false;
  }
  return existing.count >= LOCKOUT.maxAttempts;
}

/** Clear the failure counter for `username` — call this on a successful login. */
export function resetFailures(username: string): void {
  failuresByUsername.delete(normalizeUsername(username));
}

// ── Password checks in flight ────────────────────────────────────────────
// At most two sign-in password checks run at once; the rest wait their turn, and past a short
// queue a try is turned away. Many usernames tried together can't each start an Argon2 hash and
// stall the server.
const MAX_CHECKS_IN_FLIGHT = 2;
const MAX_CHECKS_WAITING = 20;
let checksInFlight = 0;
const waiting: (() => void)[] = [];

/** Run `check` when a slot is free. Returns `null` without running it when the queue is full. */
export async function withCheckSlot<T>(check: () => Promise<T>): Promise<{ value: T } | null> {
  if (checksInFlight >= MAX_CHECKS_IN_FLIGHT) {
    if (waiting.length >= MAX_CHECKS_WAITING) return null;
    await new Promise<void>((go) => waiting.push(go));
  } else {
    checksInFlight += 1;
  }
  try {
    return { value: await check() };
  } finally {
    const next = waiting.shift();
    // A waiter takes this slot over directly, so the count only drops when nobody waits.
    if (next) next();
    else checksInFlight -= 1;
  }
}
