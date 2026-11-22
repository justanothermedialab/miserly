/**
 * sharing.ts — H2 per-account sharing (the owner-controlled membership grants).
 * ============================================================================
 * H2 makes "individual privacy + shared money" real. Every account is private to
 * its `owner_id` by default; the OWNER (and only the owner — not other members,
 * NOT the admin) can grant specific Circle members full access by adding an
 * `account_members` row. This service is the ONLY writer of that table.
 *
 * Two distinct gates (never conflated — architecture §12, H2 op-considerations):
 *   - VISIBILITY (can you read it): the P0 `accountsVisibleTo`/`isAccountVisibleTo`
 *     predicate. Unchanged here — sharing only mutates its INPUT set, never the
 *     predicate. A caller who cannot see an account gets the SAME
 *     `AccountNotFoundError` as a bogus id (existence is never leaked).
 *   - OWNERSHIP (can you manage its membership): owner-only. A visible-but-not-
 *     owner caller (a member) is rejected with `NotAccountOwnerError` — they
 *     already know the account exists, so this doesn't leak anything.
 *
 * Un-share = a TOMBSTONE, not a hard delete (H2 RD7, sync-ready): the
 * `account_members` row's `deleted_at` is set; a later re-share revives it. The
 * removed member loses access immediately because `visibleWhere` filters
 * `deleted_at IS NULL` on the membership arm. Removing a member NEVER deletes
 * transactions; their `entered_by` stamps persist for the remaining holders.
 *
 * R8: async services (better-sqlite3 is sync underneath).
 * ============================================================================
 */
import { and, eq, isNull } from 'drizzle-orm';
import { today, formatDate, parseDate } from '@miserly/core';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { isAccountVisibleTo, sharesFor, SINCE_START, viewerStretches } from './visibility';
import { AccountNotFoundError } from './transactions';
import { appClock } from './clock';

type AppDb = Db['db'];

/** Thrown when a non-owner (even a full member) tries to manage membership. */
export class NotAccountOwnerError extends Error {
  constructor() {
    super('Only the account owner can manage who it is shared with');
    this.name = 'NotAccountOwnerError';
  }
}

/** Thrown when a share target is not an active Circle member. */
export class InvalidShareTargetError extends Error {
  constructor() {
    super('That member does not exist');
    this.name = 'InvalidShareTargetError';
  }
}

/** Thrown when a split doesn't name every holder once, or doesn't add to 100 % (H2 RD8). */
export class InvalidSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSplitError';
  }
}

/** A holder of an account, for the Members list on the account page. */
export interface AccountHolder {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  /** True for the single owner; false for added (shareable/removable) members. */
  readonly isOwner: boolean;
  /** The holder's share today in basis points (10,000 = 100 %; H2 RD8). */
  readonly shareBp: number;
}

/** The split's state, for the Share flyout: has the owner ever stated one, and from when. */
export interface SplitState {
  /** The latest stated split's From date; null while the split has never been stated (equal). */
  readonly statedFrom: string | null;
}

/** A Circle member's identity, for an owner's share picker. */
export interface CircleMemberIdentity {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

/**
 * The Circle's live members (IDENTITY ONLY — no financial data, no visibility
 * implication). Any authenticated member may read this: within a Circle, people
 * know who else is in it (H2 "pick people to share with"); privacy is about
 * ACCOUNTS, never the existence of members. This feeds the owner's share picker.
 */
export async function listCircleMembers(db: AppDb): Promise<CircleMemberIdentity[]> {
  return db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
    })
    .from(schema.users)
    .where(isNull(schema.users.deletedAt))
    .all();
}

/**
 * Resolve an account for a MANAGEMENT action, enforcing both gates:
 *  - not visible to `actorId` ⇒ `AccountNotFoundError` (404-identical, no leak);
 *  - visible but not owned by `actorId` ⇒ `NotAccountOwnerError`.
 * Returns the owner id on success (always == actorId here, returned for clarity).
 */
async function requireOwner(db: AppDb, actorId: string, accountId: string): Promise<string> {
  const account = db
    .select({ ownerId: schema.accounts.ownerId })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.deletedAt)))
    .get();
  // Missing OR invisible ⇒ the same 404 (never reveal a private account exists).
  if (!account || !(await isAccountVisibleTo(db, actorId, accountId))) {
    throw new AccountNotFoundError();
  }
  if (account.ownerId !== actorId) throw new NotAccountOwnerError();
  return account.ownerId;
}

/** True if `userId` is an active (live) Circle member. */
function isActiveUser(db: AppDb, userId: string): boolean {
  const row = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
    .get();
  return row !== undefined;
}

/**
 * The holders of an account (owner + added members), for the account's Members
 * panel. The CALLER must be able to see the account (any holder may view the
 * list); an invisible/missing account is a 404-identical `AccountNotFoundError`.
 */
export async function listAccountMembers(
  db: AppDb,
  viewerId: string,
  accountId: string,
): Promise<AccountHolder[]> {
  if (!(await isAccountVisibleTo(db, viewerId, accountId))) throw new AccountNotFoundError();

  const account = db
    .select({ ownerId: schema.accounts.ownerId })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.deletedAt)))
    .get();
  if (!account) throw new AccountNotFoundError();

  const owner = db
    .select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
    .from(schema.users)
    .where(eq(schema.users.id, account.ownerId))
    .get();

  const memberRows = db
    .select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
    .from(schema.accountMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.accountMembers.userId))
    .where(
      and(
        eq(schema.accountMembers.accountId, accountId),
        isNull(schema.accountMembers.deletedAt),
        isNull(schema.users.deletedAt),
      ),
    )
    .all();

  const people: Omit<AccountHolder, 'shareBp'>[] = [];
  if (owner) people.push({ userId: owner.id, username: owner.username, displayName: owner.displayName, isOwner: true });
  // The owner first, then the members by name (not by when they were added).
  for (const m of [...memberRows].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    people.push({ userId: m.id, username: m.username, displayName: m.displayName, isOwner: false });
  }
  // Each holder's share from their own view of the one rule (`sharesFor`), so the list can never
  // disagree with the figures they see.
  const todayIso = formatDate(today(appClock()));
  return Promise.all(
    people.map(async (p) => ({ ...p, shareBp: (await sharesFor(db, p.userId, [accountId])).shareBpOn(accountId, todayIso) })),
  );
}

/**
 * Whether the account's split was ever stated, and the latest change's date. Any holder may read
 * it. A member who isn't the owner reads no date before their own stretch began (that day
 * instead): an earlier date told them the account was shared with someone before them, and from
 * when.
 */
export async function splitState(db: AppDb, viewerId: string, accountId: string): Promise<SplitState> {
  if (!(await isAccountVisibleTo(db, viewerId, accountId))) throw new AccountNotFoundError();
  const rows = db
    .select({ from: schema.accountShares.effectiveFrom })
    .from(schema.accountShares)
    .where(eq(schema.accountShares.accountId, accountId))
    .all();
  const latest = rows.reduce<string | null>((m, r) => (m === null || r.from > m ? r.from : m), null);
  if (latest === null) return { statedFrom: null };
  const own = viewerStretches(db, viewerId, [accountId]).get(accountId) ?? [];
  const began = own.reduce<string | null>((m, s) => (m === null || s.from > m ? s.from : m), null);
  return { statedFrom: began !== null && began > latest ? began : latest };
}

/**
 * State the split of a shared account from a date (H2 RD8): owner-only; every current holder
 * named once, each 0 to 10,000 basis points, together exactly 10,000. It applies from `from` until
 * the next change; earlier dates keep what they had. A change on a date that already has one
 * replaces it whole (the way to correct a mistake).
 */
async function setAccountSharesOne(
  db: AppDb,
  actor: { readonly userId: string },
  accountId: string,
  from: string,
  split: Readonly<Record<string, number>>,
): Promise<Write> {
  await requireOwner(db, actor.userId, accountId);
  try {
    if (formatDate(parseDate(from)) !== from) throw new Error();
  } catch {
    throw new InvalidSplitError('Choose the date the split starts');
  }
  const holders = (await listAccountMembers(db, actor.userId, accountId)).map((h) => h.userId);
  if (holders.length < 2) throw new InvalidSplitError('Share the account with someone first');
  const named = Object.keys(split);
  if (named.length !== holders.length || !holders.every((h) => named.includes(h))) {
    throw new InvalidSplitError('Give every person with access a share');
  }
  let total = 0;
  for (const h of holders) {
    const bp = split[h]!;
    if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) throw new InvalidSplitError('Each share is between 0% and 100%');
    total += bp;
  }
  if (total !== 10_000) throw new InvalidSplitError(`The shares add up to ${total / 100}%, not 100%`);

  return (nowIso) => {
    db.delete(schema.accountShares)
      .where(and(eq(schema.accountShares.accountId, accountId), eq(schema.accountShares.effectiveFrom, from)))
      .run();
    for (const h of holders) {
      db.insert(schema.accountShares)
        .values({ accountId, userId: h, effectiveFrom: from, shareBp: split[h]!, createdAt: nowIso, updatedAt: nowIso })
        .run();
    }
  };
}

/** One account's part of a family change, written inside the family's one transaction. */
type Write = (nowIso: string, todayIso: string) => void;

/**
 * Check every account of the family first, then write them all in one transaction (security
 * read S24): a refusal on the second account used to leave the first already changed.
 */
async function forFamily(db: AppDb, accountId: string, plan: (id: string) => Promise<Write | null>): Promise<void> {
  const writes: Write[] = [];
  for (const id of accountFamilyIds(db, accountId)) {
    const w = await plan(id);
    if (w) writes.push(w);
  }
  if (writes.length === 0) return;
  const nowIso = new Date().toISOString();
  const todayIso = formatDate(today(appClock()));
  db.transaction(() => {
    for (const w of writes) w(nowIso, todayIso);
  });
}

/**
 * Start `userId`'s stretch on `accountId` on `todayIso` (C5 C): they hold it, and their share
 * counts, from that day. A stretch that ended that very day runs on instead (an unshare undone the
 * same day). Write inside the caller's transaction.
 */
function startStretch(db: AppDb, accountId: string, userId: string, todayIso: string, nowIso: string): void {
  const p = schema.accountHolderPeriods;
  const endedToday = db
    .select({ from: p.fromDate })
    .from(p)
    .where(and(eq(p.accountId, accountId), eq(p.userId, userId), eq(p.toDate, todayIso)))
    .get();
  if (endedToday) {
    db.update(p)
      .set({ toDate: null, updatedAt: nowIso })
      .where(and(eq(p.accountId, accountId), eq(p.userId, userId), eq(p.fromDate, endedToday.from)))
      .run();
    return;
  }
  db.insert(p).values({ accountId, userId, fromDate: todayIso, toDate: null, createdAt: nowIso, updatedAt: nowIso }).run();
}

/**
 * End `userId`'s open stretch on `accountId` on `todayIso` (they held it up to the day before; C5
 * C): the dates they held stay theirs. A stretch begun that day is removed (they held no
 * whole day of it), and a grant from before migration 0013, which has no row, gets its stretch
 * from the start. Shared with H3's removal from the Circle (`members.ts`). Write inside the
 * caller's transaction.
 */
export function endStretch(db: AppDb, accountId: string, userId: string, todayIso: string, nowIso: string): void {
  const p = schema.accountHolderPeriods;
  const open = db
    .select({ from: p.fromDate })
    .from(p)
    .where(and(eq(p.accountId, accountId), eq(p.userId, userId), isNull(p.toDate)))
    .get();
  if (!open) {
    if (todayIso > SINCE_START) {
      db.insert(p).values({ accountId, userId, fromDate: SINCE_START, toDate: todayIso, createdAt: nowIso, updatedAt: nowIso }).run();
    }
    return;
  }
  const key = and(eq(p.accountId, accountId), eq(p.userId, userId), eq(p.fromDate, open.from));
  if (open.from >= todayIso) db.delete(p).where(key).run();
  else db.update(p).set({ toDate: todayIso, updatedAt: nowIso }).where(key).run();
}

/** True when `userId` holds a live grant on `accountId`. */
function isLiveMember(db: AppDb, accountId: string, userId: string): boolean {
  const m = schema.accountMembers;
  return (
    db
      .select({ userId: m.userId })
      .from(m)
      .where(and(eq(m.accountId, accountId), eq(m.userId, userId), isNull(m.deletedAt)))
      .get() !== undefined
  );
}

/**
 * Grant `targetUserId` full access to `accountId` from today (the owner's day, `appClock`,
 * C5 C): they see it from today on, with its balance that day, and the split runs from today (the
 * owner keeps the whole of the past). Owner-only. Adding the owner is a no-op (they already have
 * access). Reviving a previously-unshared (tombstoned) grant un-deletes it and starts a new
 * stretch; the earlier one is kept. Idempotent for an already-active member.
 */
async function shareAccountOne(
  db: AppDb,
  actor: { readonly userId: string },
  accountId: string,
  targetUserId: string,
): Promise<Write | null> {
  await requireOwner(db, actor.userId, accountId);

  // Adding the owner is a no-op — they hold it via owner_id already.
  if (targetUserId === actor.userId) return null;
  if (!isActiveUser(db, targetUserId)) throw new InvalidShareTargetError();
  if (isLiveMember(db, accountId, targetUserId)) return null;

  return (nowIso, todayIso) => {
    // Upsert on the (account_id, user_id) PK: a fresh grant, or revive a tombstone
    // (deleted_at → NULL). `visibleWhere` filters live rows, so this restores access.
    db.insert(schema.accountMembers)
      .values({ accountId, userId: targetUserId, createdAt: nowIso, updatedAt: nowIso, deletedAt: null })
      .onConflictDoUpdate({
        target: [schema.accountMembers.accountId, schema.accountMembers.userId],
        set: { deletedAt: null, updatedAt: nowIso },
      })
      .run();
    startStretch(db, accountId, targetUserId, todayIso, nowIso);
  };
}

/**
 * Revoke `targetUserId`'s access to `accountId` from today. Owner-only. Tombstones the
 * membership row (soft-delete, H2 RD7) and ends their stretch today (the dates they held
 * keep their split, for them and the owner alike). No transactions are deleted and the member's
 * `entered_by` stamps persist. No-op if they were not a member.
 */
async function unshareAccountOne(
  db: AppDb,
  actor: { readonly userId: string },
  accountId: string,
  targetUserId: string,
): Promise<Write | null> {
  await requireOwner(db, actor.userId, accountId);
  if (!isLiveMember(db, accountId, targetUserId)) return null;

  return (nowIso, todayIso) => {
    db.update(schema.accountMembers)
      .set({ deletedAt: nowIso })
      .where(
        and(
          eq(schema.accountMembers.accountId, accountId),
          eq(schema.accountMembers.userId, targetUserId),
          isNull(schema.accountMembers.deletedAt),
        ),
      )
      .run();
    endStretch(db, accountId, targetUserId, todayIso, nowIso);
  };
}

/**
 * S5 RD16: an account and the accounts that belong to it share as one (an EPF and its EPS): the
 * parent first, then its children, whichever of them was asked. Ids of live accounts only.
 */
export function accountFamilyIds(db: AppDb, accountId: string): string[] {
  const me = db.select({ id: schema.accounts.id, parent: schema.accounts.parentAccountId }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  const root = me?.parent ?? accountId;
  const kids = db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.parentAccountId, root), isNull(schema.accounts.deletedAt)))
    .all()
    .map((r) => r.id);
  return [root, ...kids];
}

/** State the split of a shared account from a date (H2 RD8), for it and the accounts that belong to it. */
export async function setAccountShares(
  db: AppDb,
  actor: { readonly userId: string },
  accountId: string,
  from: string,
  split: Readonly<Record<string, number>>,
): Promise<void> {
  await forFamily(db, accountId, (id) => setAccountSharesOne(db, actor, id, from, split));
}

/** Share an account from today (H2, C5 C), with the accounts that belong to it (an EPF's EPS). */
export async function shareAccount(
  db: AppDb,
  actor: { readonly userId: string },
  accountId: string,
  targetUserId: string,
): Promise<void> {
  await forFamily(db, accountId, (id) => shareAccountOne(db, actor, id, targetUserId));
}

/** Stop sharing an account from today (H2), with the accounts that belong to it. */
export async function unshareAccount(
  db: AppDb,
  actor: { readonly userId: string },
  accountId: string,
  targetUserId: string,
): Promise<void> {
  await forFamily(db, accountId, (id) => unshareAccountOne(db, actor, id, targetUserId));
}
