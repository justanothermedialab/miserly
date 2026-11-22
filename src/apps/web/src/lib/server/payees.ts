/**
 * payees.ts — the F3 payee identity + integrity core.
 * ============================================================================
 * Payees are ONE canonical, de-duplicated registry keyed by `name_normalized`
 * (UNIQUE). This file owns the three correctness-critical operations — the ones
 * where a bug duplicates identity or orphans a foreign key:
 *
 *   - `resolvePayee`   — create-or-reuse by normalized name. THE anti-duplication
 *                        guarantee: "Amazon" / " amazon " / "AMAZON" resolve to
 *                        ONE row. Reusing a hidden payee un-hides it (it's in use
 *                        again). Race-safe via ON CONFLICT DO NOTHING + re-read.
 *   - `mergePayees`    — fold N loser payees into a target, ATOMICALLY: re-point
 *                        transactions + the `account_payee` / `user_payee`
 *                        projections (de-duping their composite-PK collisions),
 *                        then hard-delete the losers. Either all of it or none
 *                        (the Firefly partial-merge bug class).
 *   - `clearRememberedCategory` — the referential-integrity cascade: null out any
 *                        `user_payee.last_category_id` pointing at a category being
 *                        deleted, so a payee never pre-fills a non-existent
 *                        category. MUST be called inside the category-delete tx.
 *
 * The plainer payee CRUD (rename, the viewer-scoped autocomplete
 * list) is F3's non-critical half and lives below. R8: async.
 * ============================================================================
 */
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { normalizeName } from './names';
import { accountsVisibleTo, heldScope, heldRowCondition, inScope, type HeldScope } from './visibility';
import { categoryPickable, isPickableCategory } from './category-rules';

type AppDb = Db['db'];

export interface ResolvedPayee {
  readonly id: string;
  readonly displayName: string;
  /** True if this call created the row; false if an existing payee was reused. */
  readonly created: boolean;
}

/**
 * Resolve a typed payee name to its canonical registry row — reusing the
 * existing payee on a normalized-name match, or creating one otherwise. A hidden
 * match is un-hidden (using a payee again brings it back). The ON CONFLICT +
 * re-read makes concurrent "first use of the same new name" collapse to one row
 * rather than throwing on the UNIQUE index. Throws on an empty name.
 */
export async function resolvePayee(db: AppDb, displayName: string): Promise<ResolvedPayee> {
  const name = displayName.trim();
  if (name === '') throw new Error('resolvePayee: payee name is required');
  const normalized = normalizeName(name);

  const existing = db
    .select()
    .from(schema.payees)
    .where(eq(schema.payees.nameNormalized, normalized))
    .get();
  if (existing) {
    if (existing.hidden) {
      db.update(schema.payees)
        .set({ hidden: false, updatedAt: new Date().toISOString() })
        .where(eq(schema.payees.id, existing.id))
        .run();
    }
    return { id: existing.id, displayName: existing.displayName, created: false };
  }

  const id = randomUUID();
  db.insert(schema.payees)
    .values({ id, displayName: name, nameNormalized: normalized })
    .onConflictDoNothing()
    .run();

  // Re-read: if a concurrent caller won the insert, we adopt their row (created
  // is then false). The row is guaranteed to exist now.
  const row = db
    .select()
    .from(schema.payees)
    .where(eq(schema.payees.nameNormalized, normalized))
    .get()!;
  return { id: row.id, displayName: row.displayName, created: row.id === id };
}

/** Later of two nullable ISO timestamps (null = earliest / "never"). */
function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * Merge `loserIds` into `targetId`: every transaction and projection row that
 * pointed at a loser now points at the target, and the loser payees are removed.
 * ATOMIC — one transaction, so a failure leaves the registry untouched (no
 * half-merge orphaning transactions). The `account_payee` / `user_payee` rows
 * have composite PKs, so a loser row for an (account|user) the target already
 * has is DE-DUPED (merging recency; the target's remembered category wins —
 * F3 RD5), not blindly re-pointed into a PK collision.
 *
 * Throws if the target is missing, if a loser IS the target, or if `loserIds`
 * is empty. Duplicate/no-op loser ids are tolerated.
 */
export async function mergePayees(
  db: AppDb,
  targetId: string,
  loserIds: readonly string[],
): Promise<void> {
  const losers = [...new Set(loserIds)].filter((id) => id !== targetId);
  if (losers.length === 0) throw new Error('mergePayees: no distinct payees to merge');

  const target = db
    .select({ id: schema.payees.id })
    .from(schema.payees)
    .where(eq(schema.payees.id, targetId))
    .get();
  if (!target) throw new Error(`mergePayees: no target payee ${targetId}`);

  const now = new Date().toISOString();

  db.transaction((tx) => {
    // 1. Transactions: no uniqueness on payee_id → a straight re-point.
    tx.update(schema.transactions)
      .set({ payeeId: targetId, updatedAt: now })
      .where(inArray(schema.transactions.payeeId, losers))
      .run();

    // 2. account_payee (PK: account_id, payee_id) — fold per account, keep the
    //    latest last_used_at, then drop the loser rows.
    const apTarget = new Map<string, string | null>();
    for (const r of tx
      .select()
      .from(schema.accountPayee)
      .where(eq(schema.accountPayee.payeeId, targetId))
      .all()) {
      apTarget.set(r.accountId, r.lastUsedAt);
    }
    const apLosers = tx
      .select()
      .from(schema.accountPayee)
      .where(inArray(schema.accountPayee.payeeId, losers))
      .all();
    for (const r of apLosers) {
      apTarget.set(
        r.accountId,
        apTarget.has(r.accountId) ? laterIso(apTarget.get(r.accountId)!, r.lastUsedAt) : r.lastUsedAt,
      );
    }
    tx.delete(schema.accountPayee).where(inArray(schema.accountPayee.payeeId, losers)).run();
    for (const [accountId, lastUsedAt] of apTarget) {
      const exists = tx
        .select({ accountId: schema.accountPayee.accountId })
        .from(schema.accountPayee)
        .where(
          and(
            eq(schema.accountPayee.accountId, accountId),
            eq(schema.accountPayee.payeeId, targetId),
          ),
        )
        .get();
      if (exists) {
        tx.update(schema.accountPayee)
          .set({ lastUsedAt, updatedAt: now })
          .where(
            and(
              eq(schema.accountPayee.accountId, accountId),
              eq(schema.accountPayee.payeeId, targetId),
            ),
          )
          .run();
      } else {
        tx.insert(schema.accountPayee).values({ accountId, payeeId: targetId, lastUsedAt }).run();
      }
    }

    // 3. user_payee (PK: user_id, payee_id) — same fold per user; the TARGET's
    //    remembered category wins silently (F3 RD5), loser's fills only a gap.
    const upTarget = new Map<string, { lastCategoryId: string | null; lastUsedAt: string | null }>();
    for (const r of tx
      .select()
      .from(schema.userPayee)
      .where(eq(schema.userPayee.payeeId, targetId))
      .all()) {
      upTarget.set(r.userId, { lastCategoryId: r.lastCategoryId, lastUsedAt: r.lastUsedAt });
    }
    const upLosers = tx
      .select()
      .from(schema.userPayee)
      .where(inArray(schema.userPayee.payeeId, losers))
      .all();
    for (const r of upLosers) {
      const cur = upTarget.get(r.userId);
      if (cur) {
        upTarget.set(r.userId, {
          lastCategoryId: cur.lastCategoryId ?? r.lastCategoryId, // target wins; loser fills a gap
          lastUsedAt: laterIso(cur.lastUsedAt, r.lastUsedAt),
        });
      } else {
        upTarget.set(r.userId, { lastCategoryId: r.lastCategoryId, lastUsedAt: r.lastUsedAt });
      }
    }
    tx.delete(schema.userPayee).where(inArray(schema.userPayee.payeeId, losers)).run();
    for (const [userId, v] of upTarget) {
      const exists = tx
        .select({ userId: schema.userPayee.userId })
        .from(schema.userPayee)
        .where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, targetId)))
        .get();
      if (exists) {
        tx.update(schema.userPayee)
          .set({ lastCategoryId: v.lastCategoryId, lastUsedAt: v.lastUsedAt, updatedAt: now })
          .where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, targetId)))
          .run();
      } else {
        tx.insert(schema.userPayee)
          .values({
            userId,
            payeeId: targetId,
            lastCategoryId: v.lastCategoryId,
            lastUsedAt: v.lastUsedAt,
          })
          .run();
      }
    }

    // 4. Remove the now-orphaned loser payees.
    tx.delete(schema.payees).where(inArray(schema.payees.id, losers)).run();
  });
}

/**
 * Null out every `user_payee.last_category_id` that references `categoryId` — the
 * cascade that stops a payee from pre-filling a category that no longer exists
 * (F3 failure case: no dangling remembered-category id). MUST be invoked inside
 * the same transaction that deletes/reassigns the category (pass the tx handle),
 * so the clear and the delete commit together.
 */
export async function clearRememberedCategory(db: AppDb, categoryId: string): Promise<void> {
  db.update(schema.userPayee)
    .set({ lastCategoryId: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.userPayee.lastCategoryId, categoryId))
    .run();
}

// ============================================================================
// F3 plain payee CRUD: rename and the
// viewer-scoped list + autocomplete + remembered-category read. The identity/
// integrity core above must not change; these are the
// non-critical management + query surfaces built on top of it.
// ============================================================================

export type PayeeRow = typeof schema.payees.$inferSelect;

/** Thrown by `renamePayee` when the new name already belongs to another payee. */
export class PayeeNameConflictError extends Error {
  /** The existing payee the rename collided with — the merge target the route offers. */
  readonly conflictingId: string;
  constructor(conflictingId: string, message: string) {
    super(message);
    this.name = 'PayeeNameConflictError';
    this.conflictingId = conflictingId;
  }
}

/**
 * Rename a payee's display name, recomputing its `name_normalized` identity key.
 * If the new normalized name already belongs to a DIFFERENT payee, throws
 * `PayeeNameConflictError` (carrying that payee's id) instead of silently
 * creating a duplicate identity — the route offers a merge into it. A rename
 * that only changes casing/spacing of the SAME payee is allowed (same id).
 */
export async function renamePayee(db: AppDb, id: string, displayName: string): Promise<void> {
  const name = displayName.trim();
  if (name === '') throw new Error('renamePayee: payee name is required');
  const normalized = normalizeName(name);

  const clash = db
    .select({ id: schema.payees.id })
    .from(schema.payees)
    .where(eq(schema.payees.nameNormalized, normalized))
    .get();
  if (clash && clash.id !== id) {
    throw new PayeeNameConflictError(
      clash.id,
      'Another payee already uses that name. Merge them instead.',
    );
  }

  db.update(schema.payees)
    .set({ displayName: name, nameNormalized: normalized, updatedAt: new Date().toISOString() })
    .where(eq(schema.payees.id, id))
    .run();
}

/**
 * Hard-delete a payee (F3 RD3). Since a payee is OPTIONAL on a transaction, its
 * transactions keep working with payee = none (never orphaned); the projections
 * (`account_payee`) + per-user memory (`user_payee`) are removed. Mirrors the
 * loser-removal path in `mergePayees`.
 *
 * There is no Hide (F3 RD3 amended: Actual has none, and one shared flag
 * hid a payee from every member). `payees.hidden` stays in the frozen schema and is ignored: a
 * payee hidden before shows again, and a stale one sinks in the recency-ranked suggestions.
 */
export async function deletePayee(db: AppDb, id: string): Promise<void> {
  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(schema.transactions)
      .set({ payeeId: null, updatedAt: now })
      .where(eq(schema.transactions.payeeId, id))
      .run();
    tx.delete(schema.accountPayee).where(eq(schema.accountPayee.payeeId, id)).run();
    tx.delete(schema.userPayee).where(eq(schema.userPayee.payeeId, id)).run();
    tx.delete(schema.payees).where(eq(schema.payees.id, id)).run();
  });
}

/**
 * The payees a viewer has earned (F3; C5 C): those on the `account_payee` projection of the
 * accounts they hold on every date, and those on rows dated inside the stretches of the accounts
 * they hold from a date (a member sees nothing from before they joined, payees included).
 */
export function earnedPayeeIds(db: AppDb, scope: HeldScope): Set<string> {
  const out = new Set<string>();
  if (scope.full.length > 0) {
    for (const r of db
      .selectDistinct({ id: schema.accountPayee.payeeId })
      .from(schema.accountPayee)
      .where(inArray(schema.accountPayee.accountId, scope.full))
      .all()) out.add(r.id);
  }
  if (scope.partial.size > 0) {
    for (const r of db
      .select({ id: schema.transactions.payeeId, accountId: schema.transactions.accountId, date: schema.transactions.date })
      .from(schema.transactions)
      .where(and(inArray(schema.transactions.accountId, [...scope.partial.keys()]), isNull(schema.transactions.deletedAt), isNotNull(schema.transactions.payeeId)))
      .all()) {
      if (r.id !== null && inScope(scope, r.accountId, r.date)) out.add(r.id);
    }
  }
  return out;
}

/**
 * The payees a viewer may see: those used on an account in the viewer's visible
 * set (`accountsVisibleTo`), via the `account_payee` projection, inside the dates they held it
 * (`earnedPayeeIds`). NOT "all payees"
 * — a payee only known through a non-visible account must not leak (P0 scoping).
 * Before any transactions exist (M5), this is typically EMPTY.
 */
export async function listPayeesFor(db: AppDb, userId: string): Promise<PayeeRow[]> {
  const earned = [...earnedPayeeIds(db, await heldScope(db, userId))];
  const live = isNull(schema.payees.deletedAt);
  const used =
    earned.length === 0
      ? []
      : db
          .select()
          .from(schema.payees)
          .where(and(inArray(schema.payees.id, earned), live))
          .orderBy(asc(schema.payees.displayName))
          .all();
  const own = ownUnusedPayeeIds(db, userId);
  if (own.length === 0) return used;
  const extra = db.select().from(schema.payees).where(and(inArray(schema.payees.id, own), live)).all();
  return [...used, ...extra].sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0));
}

/**
 * F3 RD7: payees the viewer made on the Payees page (or otherwise holds their own `user_payee`
 * row for) that NO account uses yet, not even a deleted row. Visible to that viewer only: with no
 * account behind it there is nothing to leak (P0), and the first row that uses it makes it an
 * ordinary payee seen through `account_payee`.
 */
export function ownUnusedPayeeIds(db: AppDb, userId: string): string[] {
  return db
    .select({ id: schema.userPayee.payeeId })
    .from(schema.userPayee)
    .innerJoin(schema.payees, eq(schema.payees.id, schema.userPayee.payeeId))
    .where(
      and(
        eq(schema.userPayee.userId, userId),
        isNull(schema.payees.deletedAt),
        sql`NOT EXISTS (SELECT 1 FROM account_payee ap WHERE ap.payee_id = ${schema.userPayee.payeeId})`,
        sql`NOT EXISTS (SELECT 1 FROM transactions t WHERE t.payee_id = ${schema.userPayee.payeeId})`,
      ),
    )
    .all()
    .map((r) => r.id);
}

/**
 * F3 RD7: create a payee from the Payees page, with an optional default category. A name the
 * viewer already has is refused with that payee's id, as rename is. A name only
 * other members use reuses the one registry row without touching it, and stays out
 * of the viewer's list until they use it: the reply is the same either way (P0).
 */
export async function createPayeeFor(
  db: AppDb,
  userId: string,
  displayName: string,
  categoryId: string | null,
): Promise<string> {
  const name = displayName.trim();
  if (name === '') throw new Error('createPayeeFor: payee name is required');
  const clash = db.select().from(schema.payees).where(eq(schema.payees.nameNormalized, normalizeName(name))).get();
  if (clash) {
    const mine = (await listPayeesFor(db, userId)).some((p) => p.id === clash.id);
    if (mine) throw new PayeeNameConflictError(clash.id, `${clash.displayName} is already in your payees.`);
  }
  const id = clash ? clash.id : (await resolvePayee(db, name)).id;
  await setRememberedCategory(db, userId, id, categoryId);
  return id;
}

export interface PayeeStatsRow extends PayeeRow {
  /** Transactions referencing this payee across the viewer's visible accounts. */
  readonly txnCount: number;
  /** This viewer's remembered category name (F3), if still live + non-hidden. */
  readonly rememberedCategoryName: string | null;
  readonly rememberedCategoryId: string | null;
  /**
   * Date (`YYYY-MM-DD`) of the payee's latest LIVE transaction across the viewer's
   * visible accounts — the ledger date, not when it was typed in (REL-13: entry
   * time made back-dated history read "today", and a delete never moved it).
   */
  readonly lastUsedAt: string | null;
}

/**
 * The payee manager list (DEV-22): `listPayeesFor` enriched with the columns the
 * prototype shows — transaction count, this viewer's remembered category, and the
 * latest transaction date. All viewer-scoped and additive (grouped read queries over
 * already-stored columns — no schema change).
 */
export async function listPayeesWithStats(db: AppDb, userId: string): Promise<PayeeStatsRow[]> {
  const base = await listPayeesFor(db, userId);
  if (base.length === 0) return [];
  const visible = await accountsVisibleTo(db, userId);
  // C5 C: counted over the rows dated inside the viewer's stretches only.

  // Count + latest ledger date in one grouped read (the Quicken payee-list model:
  // "Uses" + "Last used" by transaction date).
  // A viewer with only their own unused payees (F3 RD7) has no accounts to count over.
  const counts = visible.length === 0 ? [] : db
    .select({ payeeId: schema.transactions.payeeId, n: count(), last: max(schema.transactions.date) })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.accountId, visible),
        isNull(schema.transactions.deletedAt),
        isNotNull(schema.transactions.payeeId),
        heldRowCondition(userId),
      ),
    )
    .groupBy(schema.transactions.payeeId)
    .all();
  const countMap = new Map(counts.map((c) => [c.payeeId, c.n]));
  const lastMap = new Map(counts.map((c) => [c.payeeId, c.last]));

  const remembered = db
    .select({ payeeId: schema.userPayee.payeeId, name: schema.categories.name, id: schema.categories.id })
    .from(schema.userPayee)
    .leftJoin(
      schema.categories,
      and(
        eq(schema.categories.id, schema.userPayee.lastCategoryId),
        categoryPickable,
      ),
    )
    .where(eq(schema.userPayee.userId, userId))
    .all();
  const catMap = new Map(remembered.map((r) => [r.payeeId, r.name]));
  const catIdMap = new Map(remembered.map((r) => [r.payeeId, r.id]));

  return base.map((p) => ({
    ...p,
    txnCount: countMap.get(p.id) ?? 0,
    rememberedCategoryName: catMap.get(p.id) ?? null,
    rememberedCategoryId: catIdMap.get(p.id) ?? null,
    lastUsedAt: lastMap.get(p.id) ?? null,
  }));
}

/**
 * Viewer-scoped payee autocomplete: payees on a visible account whose normalized
 * name CONTAINS the normalized query, ranked by recency
 * (`account_payee.last_used_at` desc, NULLs last) then display name. Capped at
 * `limit`. Consumed at capture (M6). Empty query returns the top recents.
 */
export async function payeeAutocomplete(
  db: AppDb,
  userId: string,
  query: string,
  limit = 20,
): Promise<{ id: string; displayName: string }[]> {
  const scope = await heldScope(db, userId);
  const visibleAccounts = scope.all;
  if (visibleAccounts.length === 0) return [];
  const earned = [...earnedPayeeIds(db, scope)];
  if (earned.length === 0) return [];

  const needle = normalizeName(query);
  const rows = db
    .selectDistinct({
      id: schema.payees.id,
      displayName: schema.payees.displayName,
      lastUsedAt: schema.accountPayee.lastUsedAt,
    })
    .from(schema.payees)
    .innerJoin(schema.accountPayee, eq(schema.accountPayee.payeeId, schema.payees.id))
    .where(
      and(
        inArray(schema.accountPayee.accountId, visibleAccounts),
        inArray(schema.payees.id, earned),
        isNull(schema.payees.deletedAt),
        needle === ''
          ? undefined
          : sql`${schema.payees.nameNormalized} LIKE ${`%${escapeLike(needle)}%`} ESCAPE '\\'`,
      ),
    )
    // NULLs-last recency: a present last_used_at ranks above a missing one, then
    // most-recent first; display name breaks ties deterministically.
    .orderBy(
      sql`CASE WHEN ${schema.accountPayee.lastUsedAt} IS NULL THEN 1 ELSE 0 END`,
      desc(schema.accountPayee.lastUsedAt),
      asc(schema.payees.displayName),
    )
    .limit(limit)
    .all();
  return rows.map((r) => ({ id: r.id, displayName: r.displayName }));
}

/** Escape LIKE wildcards in a user query so they match literally (ESCAPE '\'). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/gu, (ch) => `\\${ch}`);
}

/**
 * Whether the viewer may act on a payee: it is used on an account they can see,
 * or it is one of their own unused payees (F3 RD7).
 * Every Payees action checks it first, so an id from another member's private account behaves
 * as a missing one (P0: a member never learns another's private payees exist).
 */
export async function isPayeeVisibleTo(db: AppDb, userId: string, payeeId: string): Promise<boolean> {
  return earnedPayeeIds(db, await heldScope(db, userId)).has(payeeId) || ownUnusedPayeeIds(db, userId).includes(payeeId);
}

/**
 * The payee's default category for this viewer (Payees' Default category column): the category
 * a new row with this payee fills in (`user_payee.last_category_id`, F3). Null clears it.
 * Throws on a missing or hidden category.
 */
export async function setRememberedCategory(
  db: AppDb,
  userId: string,
  payeeId: string,
  categoryId: string | null,
): Promise<void> {
  if (categoryId !== null) {
    if (!isPickableCategory(db, categoryId)) throw new Error('Choose an existing category');
  }
  const now = new Date().toISOString();
  const existing = db
    .select({ userId: schema.userPayee.userId })
    .from(schema.userPayee)
    .where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, payeeId)))
    .get();
  if (existing) {
    db.update(schema.userPayee)
      .set({ lastCategoryId: categoryId, updatedAt: now })
      .where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, payeeId)))
      .run();
  } else {
    db.insert(schema.userPayee).values({ userId, payeeId, lastCategoryId: categoryId }).run();
  }
}

/**
 * The category a viewer last used for a payee (`user_payee.last_category_id`) —
 * the deterministic fill-when-blank prefill source consumed at capture (M6).
 * Null when the viewer has no remembered category for that payee.
 */
export async function rememberedCategoryFor(
  db: AppDb,
  userId: string,
  payeeId: string,
): Promise<string | null> {
  const row = db
    .select({ lastCategoryId: schema.userPayee.lastCategoryId })
    .from(schema.userPayee)
    .where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, payeeId)))
    .get();
  return row?.lastCategoryId ?? null;
}

// ============================================================================
// Item 2.5 (P4 hunt): payees are one registry shared by the group, so a member's rename, delete
// or merge reached rows in accounts they can't see (another member's private rows took the new
// name, lost their payee, or moved). A payee action now changes only the rows the actor can
// see: when the payee is also used outside them, the actor's rows move to a payee of the new
// name (or lose it), and the other rows keep theirs. The reply is the same either way (P0).
// ============================================================================

/** Is the payee on a row, or in the recency list, of an account outside the given ones? */
export function payeeUsedOutside(db: AppDb, payeeId: string, scope: HeldScope): boolean {
  // C5 C: a row dated outside the actor's stretches is someone else's, as is any projection on an
  // account they hold only from a date.
  const tx = db
    .select({ a: schema.transactions.accountId, d: schema.transactions.date })
    .from(schema.transactions)
    .where(eq(schema.transactions.payeeId, payeeId))
    .all()
    .some((r) => !inScope(scope, r.a, r.d));
  if (tx) return true;
  const full = new Set(scope.full);
  const ap = db.select({ a: schema.accountPayee.accountId }).from(schema.accountPayee).where(eq(schema.accountPayee.payeeId, payeeId)).all().some((r) => !full.has(r.a));
  return ap;
}

/**
 * Move the actor's share of a payee (its rows and recency on `visible` accounts, the actor's own
 * remembered category) to `toId`, or to no payee when `toId` is null. The payee row itself and
 * everything outside `visible` stay. Runs in one transaction.
 */
export function movePayeeRows(db: AppDb, fromId: string, toId: string | null, scope: HeldScope, userId: string): void {
  if (scope.all.length === 0) return;
  const now = new Date().toISOString();
  // C5 C: only the rows dated inside the actor's stretches move; on an account held from a date the
  // old projection stays for the rows before it (only a new one is added).
  const moved = db
    .select({ id: schema.transactions.id, a: schema.transactions.accountId, d: schema.transactions.date })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.payeeId, fromId), inArray(schema.transactions.accountId, scope.all)))
    .all()
    .filter((r) => inScope(scope, r.a, r.d));
  const rowIds = moved.map((r) => r.id);
  // The new payee is recorded as used only on an account where a row of the actor's moved, or
  // one they hold on every date. Copying the record to an account held from a date put the new
  // name in its owner's list though none of their rows uses it.
  const earns = new Set([...moved.map((r) => r.a), ...scope.full]);
  db.transaction((tx) => {
    if (rowIds.length > 0) {
      tx.update(schema.transactions)
        .set({ payeeId: toId, updatedAt: now })
        .where(inArray(schema.transactions.id, rowIds))
        .run();
    }
    const aps = tx.select().from(schema.accountPayee).where(and(eq(schema.accountPayee.payeeId, fromId), inArray(schema.accountPayee.accountId, scope.all))).all();
    if (scope.full.length > 0) {
      tx.delete(schema.accountPayee).where(and(eq(schema.accountPayee.payeeId, fromId), inArray(schema.accountPayee.accountId, scope.full))).run();
    }
    const up = tx.select().from(schema.userPayee).where(and(eq(schema.userPayee.payeeId, fromId), eq(schema.userPayee.userId, userId))).get();
    tx.delete(schema.userPayee).where(and(eq(schema.userPayee.payeeId, fromId), eq(schema.userPayee.userId, userId))).run();
    if (toId === null) return;
    for (const r of aps) {
      if (!earns.has(r.accountId)) continue;
      const ex = tx.select().from(schema.accountPayee).where(and(eq(schema.accountPayee.accountId, r.accountId), eq(schema.accountPayee.payeeId, toId))).get();
      if (ex) {
        tx.update(schema.accountPayee)
          .set({ lastUsedAt: laterIso(ex.lastUsedAt, r.lastUsedAt), updatedAt: now })
          .where(and(eq(schema.accountPayee.accountId, r.accountId), eq(schema.accountPayee.payeeId, toId)))
          .run();
      } else tx.insert(schema.accountPayee).values({ accountId: r.accountId, payeeId: toId, lastUsedAt: r.lastUsedAt }).run();
    }
    if (up) {
      const ex = tx.select().from(schema.userPayee).where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, toId))).get();
      if (ex) {
        tx.update(schema.userPayee)
          .set({ lastCategoryId: ex.lastCategoryId ?? up.lastCategoryId, lastUsedAt: laterIso(ex.lastUsedAt, up.lastUsedAt), updatedAt: now })
          .where(and(eq(schema.userPayee.userId, userId), eq(schema.userPayee.payeeId, toId)))
          .run();
      } else tx.insert(schema.userPayee).values({ userId, payeeId: toId, lastCategoryId: up.lastCategoryId, lastUsedAt: up.lastUsedAt }).run();
    }
  });
}

/** Delete a payee the actor can see, scoped: the whole payee when only the actor's accounts use it. */
export async function deletePayeeFor(db: AppDb, userId: string, id: string): Promise<void> {
  const visible = await heldScope(db, userId);
  if (payeeUsedOutside(db, id, visible)) movePayeeRows(db, id, null, visible, userId);
  else await deletePayee(db, id);
}

/**
 * Rename a payee the actor can see. Used only on the actor's accounts: a plain rename (a clash
 * with another payee the actor can see throws PayeeNameConflictError, so the page offers Merge).
 * Also used elsewhere, or clashing with a payee only others use: the actor's rows move to a payee
 * of the new name and nothing outside their accounts changes.
 */
export async function renamePayeeFor(db: AppDb, userId: string, id: string, displayName: string): Promise<void> {
  const visible = await heldScope(db, userId);
  const visibleIds = new Set((await listPayeesFor(db, userId)).map((p) => p.id));
  const clash = db.select({ id: schema.payees.id }).from(schema.payees).where(eq(schema.payees.nameNormalized, normalizeName(displayName))).get();
  if (clash && clash.id !== id && visibleIds.has(clash.id)) {
    throw new PayeeNameConflictError(clash.id, 'Another payee already uses that name. Merge them instead.');
  }
  if ((clash && clash.id !== id) || payeeUsedOutside(db, id, visible)) {
    const target = await resolvePayee(db, displayName);
    if (target.id !== id) movePayeeRows(db, id, target.id, visible, userId);
    if (target.id === id) await renamePayee(db, id, displayName); // a casing change of the same name
    return;
  }
  await renamePayee(db, id, displayName);
}

/** Merge payees the actor can see into a target they can see, scoped to the actor's rows. */
export async function mergePayeesFor(db: AppDb, userId: string, targetId: string, loserIds: readonly string[]): Promise<void> {
  const visible = await heldScope(db, userId);
  const losers = [...new Set(loserIds)].filter((x) => x !== targetId);
  if (losers.length === 0) throw new Error('mergePayees: no distinct payees to merge');
  const whole = losers.filter((l) => !payeeUsedOutside(db, l, visible));
  if (whole.length > 0) await mergePayees(db, targetId, whole);
  for (const l of losers.filter((x) => !whole.includes(x))) movePayeeRows(db, l, targetId, visible, userId);
}
