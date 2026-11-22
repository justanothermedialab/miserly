/**
 * members.ts — H3 Circle membership administration (admin-only, NOT data access).
 * ============================================================================
 * The defining privacy stance (HH-6, architecture §12): the admin manages
 * PEOPLE, never DATA. Every function here gates on `actor.role === 'admin'`
 * (`assertAdmin`) as defense-in-depth on top of the route's own role check —
 * but NONE of them read anyone's financial data. Admin has NO visibility
 * override anywhere; that omission is the guarantee.
 *
 * The two hard safety rules (H3):
 *   1. LAST-ADMIN: the Circle can never be left admin-less. In MVP (single admin)
 *      this means an admin row can never be removed — `removeMember` refuses a
 *      target whose role is 'admin' (which also blocks the admin removing self).
 *   2. NO ORPHANED SHARED ACCOUNT: removing a member who SOLELY owns shared
 *      accounts (accounts they own that ≥1 OTHER member can see) is blocked until
 *      the owner reassigns/unshares — a shared account is never orphaned or
 *      silently transferred.
 *
 * A successful removal is ONE transaction (never a partial state): tombstone the
 * member's `account_members` grants (co-members lose that person's access),
 * hard-delete their sessions (immediate revocation), and soft-delete the `users`
 * row (retain-as-inaccessible — their private accounts stay in the file but no
 * one can see them; a true hard "delete my data" purge is a later explicit act).
 *
 * R8: async services.
 * ============================================================================
 */
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { hashPassword } from './auth/password';
import { today, formatDate } from '@miserly/core';
import { appClock } from './clock';
import { endStretch } from './sharing';

type AppDb = Db['db'];
type Actor = { readonly id: string; readonly role: 'admin' | 'member' };

/** Thrown when a non-admin invokes a membership-management action. */
export class NotAdminError extends Error {
  constructor() {
    super('Only the admin can manage members');
    this.name = 'NotAdminError';
  }
}

/** Thrown when an action would leave the Circle without an admin. */
export class LastAdminError extends Error {
  constructor() {
    super('The group admin cannot be removed');
    this.name = 'LastAdminError';
  }
}

/** Thrown when removing a member is blocked by shared accounts they solely own. */
export class SharedOwnershipError extends Error {
  /** The blocking accounts (name + id), so the UI can name what must be resolved. */
  readonly accounts: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  constructor(accounts: ReadonlyArray<{ readonly id: string; readonly name: string }>) {
    super('This member owns shared accounts. Reassign or unshare them first.');
    this.name = 'SharedOwnershipError';
    this.accounts = accounts;
  }
}

/** Thrown when the target member id is not an active user. */
export class MemberNotFoundError extends Error {
  constructor() {
    super('No such member');
    this.name = 'MemberNotFoundError';
  }
}

function assertAdmin(actor: Actor): void {
  if (actor.role !== 'admin') throw new NotAdminError();
}

export interface MemberRow {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: 'admin' | 'member';
  readonly mustChangePassword: boolean;
  /** Most-recent session use (ISO), or null if never signed in / no live session. */
  readonly lastActiveAt: string | null;
}

/**
 * All live Circle members (identity only — NO financial data). Admin-only. The
 * `lastActiveAt` is the newest `last_used_at` across the member's live sessions.
 */
export async function listMembers(db: AppDb, actor: Actor): Promise<MemberRow[]> {
  assertAdmin(actor);

  const users = db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      role: schema.users.role,
      mustChangePassword: schema.users.mustChangePassword,
    })
    .from(schema.users)
    .where(isNull(schema.users.deletedAt))
    .all();

  const sessions = db
    .select({ userId: schema.sessions.userId, lastUsedAt: schema.sessions.lastUsedAt })
    .from(schema.sessions)
    .where(isNull(schema.sessions.deletedAt))
    .all();
  const lastActive = new Map<string, string>();
  for (const s of sessions) {
    const prev = lastActive.get(s.userId);
    if (!prev || s.lastUsedAt > prev) lastActive.set(s.userId, s.lastUsedAt);
  }

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    lastActiveAt: lastActive.get(u.id) ?? null,
  }));
}

/** Load an active user row, or throw `MemberNotFoundError`. */
function requireActiveUser(db: AppDb, userId: string) {
  const row = db
    .select({ id: schema.users.id, role: schema.users.role, username: schema.users.username })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
    .get();
  if (!row) throw new MemberNotFoundError();
  return row;
}

/** A live user's username, or null (the password rule checks a reset against it). */
export function liveUsername(db: AppDb, userId: string): string | null {
  const row = db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
    .get();
  return row?.username ?? null;
}

/**
 * Admin resets a member's password to a temp value + forces a change on next
 * sign-in (`must_change_password`). Also revokes the member's existing sessions
 * (a reset implies they lost access). Admin-only. The old password is never
 * revealed (it is not recoverable — Argon2id).
 */
export async function resetMemberPassword(
  db: AppDb,
  actor: Actor,
  targetUserId: string,
  tempPassword: string,
  // The admin can sign in as the member after this, so it is never unseen (S4, H3 RD9):
  // the day is stamped, and the member's first page after the forced change says so.
  resetDay: string = formatDate(today(appClock())),
): Promise<{ username: string }> {
  assertAdmin(actor);
  const target = requireActiveUser(db, targetUserId);

  const passwordHash = await hashPassword(tempPassword);
  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(schema.users)
      .set({ passwordHash, mustChangePassword: true, passwordResetAt: resetDay, updatedAt: nowIso })
      .where(eq(schema.users.id, targetUserId))
      .run();
    // Revoke live sessions so a reset takes effect immediately.
    tx.delete(schema.sessions).where(eq(schema.sessions.userId, targetUserId)).run();
  });
  return { username: target.username };
}

/**
 * The live accounts `ownerId` owns that are SHARED — i.e. have ≥1 live
 * `account_members` grant (to someone other than the owner; the owner is never a
 * member row). These block the owner's removal (H3 rule 2).
 */
function sharedAccountsOwnedBy(db: AppDb, ownerId: string): Array<{ id: string; name: string }> {
  const owned = db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.ownerId, ownerId), isNull(schema.accounts.deletedAt)))
    .all();

  return owned.filter((a) => {
    const grant = db
      .select({ userId: schema.accountMembers.userId })
      .from(schema.accountMembers)
      .where(
        and(
          eq(schema.accountMembers.accountId, a.id),
          isNull(schema.accountMembers.deletedAt),
        ),
      )
      .get();
    return grant !== undefined;
  });
}

/**
 * Admin removes a member from the Circle. Admin-only. Blocked if the target is an
 * admin (last-admin protection — MVP single admin) or solely owns shared accounts
 * (no orphaned shared account). On success, atomically: tombstone their grants on
 * others' accounts (co-holders lose that access), revoke their sessions, and
 * soft-delete the user (retain-as-inaccessible). Their authored history + private
 * accounts remain in the file, invisible.
 */
export async function removeMember(db: AppDb, actor: Actor, targetUserId: string): Promise<{ username: string }> {
  assertAdmin(actor);
  const target = requireActiveUser(db, targetUserId);

  // Rule 1: never remove an admin (blocks the admin removing self, too).
  if (target.role === 'admin') throw new LastAdminError();

  // Rule 2: never orphan a shared account they own.
  const blocking = sharedAccountsOwnedBy(db, targetUserId);
  if (blocking.length > 0) throw new SharedOwnershipError(blocking);

  const nowIso = new Date().toISOString();
  const todayIso = formatDate(today(appClock()));
  const grants = db
    .select({ accountId: schema.accountMembers.accountId })
    .from(schema.accountMembers)
    .where(and(eq(schema.accountMembers.userId, targetUserId), isNull(schema.accountMembers.deletedAt)))
    .all();
  db.transaction((tx) => {
    // Their stretches end today (C5 C): the dates they held stay theirs, so co-holders' past
    // figures don't change.
    for (const g of grants) endStretch(db, g.accountId, targetUserId, todayIso, nowIso);
    // Their grants on OTHER people's accounts → tombstoned (co-holders lose them).
    tx.update(schema.accountMembers)
      .set({ deletedAt: nowIso })
      .where(and(eq(schema.accountMembers.userId, targetUserId), isNull(schema.accountMembers.deletedAt)))
      .run();
    // Sessions hard-deleted → immediate revocation.
    tx.delete(schema.sessions).where(eq(schema.sessions.userId, targetUserId)).run();
    // The user soft-deleted → retained but inaccessible (their private accounts
    // stay owned-by-them and, with no other holders, are visible to no one).
    tx.update(schema.users)
      .set({ deletedAt: nowIso, updatedAt: nowIso })
      .where(eq(schema.users.id, targetUserId))
      .run();
  });
  return { username: target.username };
}
