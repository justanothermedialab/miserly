/**
 * categories.ts — the F2 category + group service (the plain CRUD).
 * ============================================================================
 * Categories are grouped, and a group carries the `kind` (income | spending |
 * neutral) that drives spending-analytics inclusion (R2/R3). The ONE place that
 * maps a category → its kind is `kindOf` here; everything downstream that needs
 * a transaction's kind calls it (never re-derives the join), so the rule lives
 * in exactly one place.
 *
 * Two non-destructive lifecycles, distinct on purpose (F2):
 *   - HIDE (`hidden` flag): removes a group/category from pickers + the manager's
 *     default view but keeps every row + all history; fully reversible.
 *   - DELETE (`deleted_at` tombstone): removes for good. A group can only be
 *     deleted once EMPTY (no live, non-hidden categories) — "empty or reassign
 *     first". A category delete is ATOMIC: its live transactions are re-pointed
 *     (to a chosen target, or to Uncategorized = NULL), any payee that remembered
 *     it is cleared (referential-integrity cascade via `clearRememberedCategory`),
 *     then the row is tombstoned — all in one transaction.
 *
 * Uniqueness uses the canonical `normalizeName` (case/space-insensitive): group
 * names unique among ACTIVE groups; category names unique among ACTIVE categories
 * within their group. R8: every DB-touching fn is async.
 * ============================================================================
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { normalizeName } from './names';
import { clearRememberedCategory } from './payees';
import { nextSwatch } from '../swatches';
import { BALANCE_ADJUSTMENT_CATEGORY_ID } from './seed';
import { accountsVisibleTo, heldRowCondition } from './visibility';

type AppDb = Db['db'];

/** `investments` (C2 A) is Not in reports like `neutral`, and R3's Invested reads it. */
export type Kind = 'income' | 'spending' | 'neutral' | 'investments';

type CategoryGroupRow = typeof schema.categoryGroups.$inferSelect;
type CategoryRow = typeof schema.categories.$inferSelect;

export interface GroupWithCategories extends CategoryGroupRow {
  readonly categories: CategoryRow[];
}

/** Thrown when a create/rename/move would collide with an existing active name. */
export class CategoryNameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryNameConflictError';
  }
}

/** Thrown when a group delete is refused because it still holds live categories. */
export class GroupNotEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupNotEmptyError';
  }
}

/** Thrown when a category delete needs a reassignment target but wasn't given one. */
export class CategoryReassignRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryReassignRequiredError';
  }
}

/**
 * Thrown when a change would break the system "Balance adjustment" category or its group
 *: a close posts its zeroing row there, Neutral, so it is never spending and never in To
 * categorize. Rename and hide stay allowed; delete, move and a kind change don't.
 */
export class SystemCategoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemCategoryError';
  }
}

/**
 * Thrown when a member would delete a category (or a group, or change a group's kind) that has
 * rows they can't see (F2 RD). Categories are one
 * list for the group, but the delete would move other members' rows and the kind would change
 * their reports. The refusal says such rows exist, which is stated in the guide.
 */
export class OtherMembersRowsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtherMembersRowsError';
  }
}

/** The actor a delete or kind change is checked against; without one (seeding, tests) none is. */
export interface CategoryActor {
  readonly userId: string;
}

/**
 * True when a live row under one of `categoryIds`, in a live account, is one `userId` can't see:
 * its account isn't one they hold now, or its date is outside the dates they held it.
 */
async function hasRowsHiddenFrom(db: AppDb, userId: string, categoryIds: readonly string[]): Promise<boolean> {
  if (categoryIds.length === 0) return false;
  const visible = await accountsVisibleTo(db, userId);
  const t = schema.transactions;
  const seen = visible.length > 0 ? and(inArray(t.accountId, visible), heldRowCondition(userId)) : sql`0`;
  const row = db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        inArray(t.categoryId, [...categoryIds]),
        isNull(t.deletedAt),
        sql`EXISTS (SELECT 1 FROM accounts la WHERE la.id = ${t.accountId} AND la.deleted_at IS NULL)`,
        sql`NOT (${seen})`,
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

const liveCategoryIdsIn = (db: AppDb, groupId: string): string[] =>
  db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(and(eq(schema.categories.groupId, groupId), isNull(schema.categories.deletedAt)))
    .all()
    .map((c) => c.id);

/** The group holding the system category, found by its fixed id (the group's name can change). */
function systemGroupId(db: AppDb): string | null {
  return (
    db
      .select({ groupId: schema.categories.groupId })
      .from(schema.categories)
      .where(and(eq(schema.categories.id, BALANCE_ADJUSTMENT_CATEGORY_ID), isNull(schema.categories.deletedAt)))
      .get()?.groupId ?? null
  );
}

// ── kind resolution (the single category → group → kind mapping) ────────────

/**
 * The kind of a category, via its group. Returns null when the category id does
 * not resolve to a live category + live group. THE single source of a category's
 * kind (R2/R3 spending inclusion at M10 will read only this).
 */
export async function kindOf(db: AppDb, categoryId: string): Promise<Kind | null> {
  const row = db
    .select({ kind: schema.categoryGroups.kind })
    .from(schema.categories)
    .innerJoin(schema.categoryGroups, eq(schema.categories.groupId, schema.categoryGroups.id))
    .where(and(eq(schema.categories.id, categoryId), isNull(schema.categories.deletedAt)))
    .get();
  return row?.kind ?? null;
}

// ── groups ──────────────────────────────────────────────────────────────────

/** Live (non-tombstoned) groups. `activeOnly` also excludes hidden ones. */
function groupRows(db: AppDb, activeOnly: boolean): CategoryGroupRow[] {
  const rows = db
    .select()
    .from(schema.categoryGroups)
    .where(isNull(schema.categoryGroups.deletedAt))
    .all();
  return activeOnly ? rows.filter((g) => !g.hidden) : rows;
}

function assertGroupNameFree(db: AppDb, name: string, excludeId?: string): void {
  const target = normalizeName(name);
  const clash = groupRows(db, true).some(
    (g) => g.id !== excludeId && normalizeName(g.name) === target,
  );
  if (clash) {
    throw new CategoryNameConflictError('A group with that name already exists');
  }
}

export async function createGroup(
  db: AppDb,
  input: { name: string; kind: Kind },
): Promise<CategoryGroupRow> {
  const name = input.name.trim();
  if (name === '') throw new Error('createGroup: name is required');
  assertGroupNameFree(db, name);

  const maxRow = db
    .select({ max: sql<number>`COALESCE(MAX(${schema.categoryGroups.sortOrder}), -1)` })
    .from(schema.categoryGroups)
    .get();
  const sortOrder = (maxRow?.max ?? -1) + 1;

  const id = randomUUID();
  db.insert(schema.categoryGroups).values({ id, name, kind: input.kind, sortOrder }).run();
  return db.select().from(schema.categoryGroups).where(eq(schema.categoryGroups.id, id)).get()!;
}

export async function renameGroup(db: AppDb, id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('renameGroup: name is required');
  assertGroupNameFree(db, trimmed, id);
  db.update(schema.categoryGroups)
    .set({ name: trimmed, updatedAt: new Date().toISOString() })
    .where(eq(schema.categoryGroups.id, id))
    .run();
}

export async function setGroupKind(db: AppDb, id: string, kind: Kind, actor?: CategoryActor): Promise<void> {
  const current = db.select({ kind: schema.categoryGroups.kind }).from(schema.categoryGroups).where(eq(schema.categoryGroups.id, id)).get();
  if (id === systemGroupId(db)) {
    if (current && current.kind !== kind) {
      throw new SystemCategoryError("This group holds Balance adjustment, which a close uses, so it stays Not in reports. You can rename or hide it.");
    }
  }
  // A kind decides what every member's reports count, so it changes only when the actor sees
  // every row under the group (S5).
  if (actor && current && current.kind !== kind && (await hasRowsHiddenFrom(db, actor.userId, liveCategoryIdsIn(db, id)))) {
    throw new OtherMembersRowsError("Other members have rows in this group, so its kind can't be changed.");
  }
  db.update(schema.categoryGroups)
    .set({ kind, updatedAt: new Date().toISOString() })
    .where(eq(schema.categoryGroups.id, id))
    .run();
}

export async function hideGroup(db: AppDb, id: string): Promise<void> {
  db.update(schema.categoryGroups)
    .set({ hidden: true, updatedAt: new Date().toISOString() })
    .where(eq(schema.categoryGroups.id, id))
    .run();
}

export async function unhideGroup(db: AppDb, id: string): Promise<void> {
  db.update(schema.categoryGroups)
    .set({ hidden: false, updatedAt: new Date().toISOString() })
    .where(eq(schema.categoryGroups.id, id))
    .run();
}

/**
 * Soft-delete a group. GUARDED twice (F2 "empty or reassign first"; Actual's
 * delete-is-merge model — a transaction-bearing category is never silently
 * dropped):
 *   1. refuses while the group holds any live, NON-HIDDEN category;
 *   2. refuses while any live HIDDEN category in it still has live
 *      transactions — tombstoning it here would orphan those rows onto a
 *      deleted category with no reassignment prompt; the user deletes that
 *      category explicitly first (where `deleteCategory` forces the choice).
 * The remaining hidden, transaction-free categories are tombstoned with the
 * group — WITH the `clearRememberedCategory` cascade, so no payee is left
 * remembering a deleted category (the same integrity rule as `deleteCategory`).
 */
export async function deleteGroup(db: AppDb, id: string, actor?: CategoryActor): Promise<void> {
  // Hiding Balance adjustment let its group's delete take it along (the reviewer's hole).
  if (id === systemGroupId(db)) {
    throw new SystemCategoryError("This group holds Balance adjustment, which a close uses, so it can't be deleted. You can rename or hide it.");
  }
  const now = new Date().toISOString();
  const liveCategories = db
    .select({ id: schema.categories.id, hidden: schema.categories.hidden })
    .from(schema.categories)
    .where(and(eq(schema.categories.groupId, id), isNull(schema.categories.deletedAt)))
    .all();

  if (liveCategories.some((c) => !c.hidden)) {
    throw new GroupNotEmptyError('Empty or reassign this group’s categories first');
  }

  const hiddenIds = liveCategories.map((c) => c.id);
  if (actor && (await hasRowsHiddenFrom(db, actor.userId, hiddenIds))) {
    throw new OtherMembersRowsError("Other members have rows in this group, so it can't be deleted. You can hide it.");
  }
  if (hiddenIds.length > 0) {
    const txCount = db
      .select({ c: sql<number>`COUNT(*)` })
      .from(schema.transactions)
      .where(
        and(
          inArray(schema.transactions.categoryId, hiddenIds),
          isNull(schema.transactions.deletedAt),
        ),
      )
      .get();
    if ((txCount?.c ?? 0) > 0) {
      throw new GroupNotEmptyError(
        'A hidden category in this group still has transactions. Delete or reassign it first.',
      );
    }
  }

  db.transaction((tx) => {
    // Tombstone the (transaction-free) hidden categories with the group, and
    // clear any remembered-category pointer at each (referential integrity).
    for (const categoryId of hiddenIds) {
      void clearRememberedCategory(tx as unknown as AppDb, categoryId);
    }
    tx.update(schema.categories)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(schema.categories.groupId, id), isNull(schema.categories.deletedAt)))
      .run();
    tx.update(schema.categoryGroups)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.categoryGroups.id, id))
      .run();
  });
}

// ── categories ────────────────────────────────────────────────────────────

/** Live categories in a group. `activeOnly` also excludes hidden ones. */
function categoryRowsInGroup(db: AppDb, groupId: string, activeOnly: boolean): CategoryRow[] {
  const rows = db
    .select()
    .from(schema.categories)
    .where(and(eq(schema.categories.groupId, groupId), isNull(schema.categories.deletedAt)))
    .all();
  return activeOnly ? rows.filter((c) => !c.hidden) : rows;
}

function assertCategoryNameFree(
  db: AppDb,
  groupId: string,
  name: string,
  excludeId?: string,
): void {
  const target = normalizeName(name);
  const clash = categoryRowsInGroup(db, groupId, true).some(
    (c) => c.id !== excludeId && normalizeName(c.name) === target,
  );
  if (clash) {
    throw new CategoryNameConflictError('A category with that name already exists in this group');
  }
}

function liveGroup(db: AppDb, groupId: string): CategoryGroupRow | undefined {
  return db
    .select()
    .from(schema.categoryGroups)
    .where(and(eq(schema.categoryGroups.id, groupId), isNull(schema.categoryGroups.deletedAt)))
    .get();
}

export async function createCategory(
  db: AppDb,
  input: { groupId: string; name: string; colour?: string | null },
): Promise<CategoryRow> {
  const name = input.name.trim();
  if (name === '') throw new Error('createCategory: name is required');
  if (!liveGroup(db, input.groupId)) {
    throw new Error(`createCategory: no live group ${input.groupId}`);
  }
  assertCategoryNameFree(db, input.groupId, name);

  const maxRow = db
    .select({ max: sql<number>`COALESCE(MAX(${schema.categories.sortOrder}), -1)` })
    .from(schema.categories)
    .where(eq(schema.categories.groupId, input.groupId))
    .get();
  const sortOrder = (maxRow?.max ?? -1) + 1;

  // F2 RD3 / RD6: a blank colour is auto-assigned the next swatch, so every category keeps
  // one colour on every chart (colour follows the entity, never its rank).
  let colour = input.colour ?? null;
  if (colour === null) {
    const used = db.select({ colour: schema.categories.colour }).from(schema.categories).where(isNull(schema.categories.deletedAt)).all();
    colour = nextSwatch(used.map((r) => r.colour));
  }

  const id = randomUUID();
  db.insert(schema.categories)
    .values({ id, groupId: input.groupId, name, sortOrder, colour })
    .run();
  return db.select().from(schema.categories).where(eq(schema.categories.id, id)).get()!;
}

export async function renameCategory(db: AppDb, id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('renameCategory: name is required');
  const current = db
    .select({ groupId: schema.categories.groupId })
    .from(schema.categories)
    .where(eq(schema.categories.id, id))
    .get();
  if (!current) throw new Error(`renameCategory: no category ${id}`);
  assertCategoryNameFree(db, current.groupId, trimmed, id);
  db.update(schema.categories)
    .set({ name: trimmed, updatedAt: new Date().toISOString() })
    .where(eq(schema.categories.id, id))
    .run();
}

export async function moveCategory(db: AppDb, id: string, newGroupId: string): Promise<void> {
  const current = db
    .select({ name: schema.categories.name })
    .from(schema.categories)
    .where(eq(schema.categories.id, id))
    .get();
  if (!current) throw new Error(`moveCategory: no category ${id}`);
  if (!liveGroup(db, newGroupId)) throw new Error(`moveCategory: no live group ${newGroupId}`);
  if (id === BALANCE_ADJUSTMENT_CATEGORY_ID && newGroupId !== systemGroupId(db)) {
    throw new SystemCategoryError("Balance adjustment is used when an account closes, so it stays in its group. You can rename or hide it.");
  }
  // A move can collide with a same-named category already in the target group.
  assertCategoryNameFree(db, newGroupId, current.name, id);
  db.update(schema.categories)
    .set({ groupId: newGroupId, updatedAt: new Date().toISOString() })
    .where(eq(schema.categories.id, id))
    .run();
}

export async function setColour(db: AppDb, id: string, colour: string | null): Promise<void> {
  db.update(schema.categories)
    .set({ colour, updatedAt: new Date().toISOString() })
    .where(eq(schema.categories.id, id))
    .run();
}

/**
 * "Counts as return (gain or loss)" (C3 A; F2 RD10). On a holding, a row under a
 * category with it on is growth; with it off, money put in or taken out. The person's choice, so
 * no lock (the system Balance adjustment is a loss or gain either way; its group is locked).
 */
export async function setCountsAsReturn(db: AppDb, id: string, on: boolean): Promise<void> {
  db.update(schema.categories)
    .set({ countsAsReturn: on, updatedAt: new Date().toISOString() })
    .where(eq(schema.categories.id, id))
    .run();
}

export async function hideCategory(db: AppDb, id: string): Promise<void> {
  db.update(schema.categories)
    .set({ hidden: true, updatedAt: new Date().toISOString() })
    .where(eq(schema.categories.id, id))
    .run();
}

export async function unhideCategory(db: AppDb, id: string): Promise<void> {
  db.update(schema.categories)
    .set({ hidden: false, updatedAt: new Date().toISOString() })
    .where(eq(schema.categories.id, id))
    .run();
}

/**
 * Delete a category, ATOMICALLY re-pointing its live transactions and cascading
 * the payee "remembered category" clear (F2/F3). If the category still has ≥1
 * live transaction and no `reassignToId` is supplied, throws
 * `CategoryReassignRequiredError` (the user must choose a target). Otherwise, in
 * ONE transaction: re-point its live transactions to `reassignToId`
 * (`null`/undefined = Uncategorized), clear any `user_payee.last_category_id`
 * pointing at it, then tombstone the row. A non-null `reassignToId` must name a
 * live category.
 */
export async function deleteCategory(
  db: AppDb,
  id: string,
  reassignToId?: string | null,
  actor?: CategoryActor,
): Promise<void> {
  if (id === BALANCE_ADJUSTMENT_CATEGORY_ID) {
    throw new SystemCategoryError("Balance adjustment is used when an account closes, so it can't be deleted. You can rename or hide it.");
  }
  // Checked before "choose where to move them", so a member hears one answer about rows they
  // can't see, not a count over every account (S5).
  if (actor && (await hasRowsHiddenFrom(db, actor.userId, [id]))) {
    throw new OtherMembersRowsError("Other members have rows in this category, so it can't be deleted. You can hide it.");
  }
  const liveTxCount = db
    .select({ c: sql<number>`COUNT(*)` })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.categoryId, id), isNull(schema.transactions.deletedAt)))
    .get();
  const hasLiveTx = (liveTxCount?.c ?? 0) > 0;

  if (hasLiveTx && reassignToId === undefined) {
    throw new CategoryReassignRequiredError(
      'This category still has transactions. Choose where to move them.',
    );
  }

  const target = reassignToId ?? null;
  if (target !== null) {
    if (target === id) throw new Error('deleteCategory: cannot reassign a category to itself');
    const exists = db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(eq(schema.categories.id, target), isNull(schema.categories.deletedAt)))
      .get();
    if (!exists) throw new Error(`deleteCategory: reassign target ${target} is not a live category`);
  }

  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(schema.transactions)
      .set({ categoryId: target, updatedAt: now })
      .where(and(eq(schema.transactions.categoryId, id), isNull(schema.transactions.deletedAt)))
      .run();
    // Referential-integrity cascade: no payee may remember a deleted category.
    // clearRememberedCategory's body runs synchronously via drizzle .run(), so
    // calling it inside this synchronous transaction keeps the clear + delete
    // atomic; `void` marks the (already-settled) promise as intentionally unawaited.
    void clearRememberedCategory(tx as unknown as AppDb, id);
    tx.update(schema.categories)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.categories.id, id))
      .run();
  });
}

// ── tree (manager + picker) ─────────────────────────────────────────────────

/**
 * The full group → category tree for the manager and pickers: groups ordered by
 * (sort_order, name), each with its categories ordered the same way. Tombstoned
 * rows never appear; hidden rows appear only with `includeHidden`.
 */
export async function listCategoryTree(
  db: AppDb,
  opts: { includeHidden?: boolean } = {},
): Promise<GroupWithCategories[]> {
  const includeHidden = opts.includeHidden ?? false;

  const groups = db
    .select()
    .from(schema.categoryGroups)
    .where(isNull(schema.categoryGroups.deletedAt))
    .orderBy(asc(schema.categoryGroups.sortOrder), asc(schema.categoryGroups.name))
    .all()
    .filter((g) => includeHidden || !g.hidden);

  const categories = db
    .select()
    .from(schema.categories)
    .where(isNull(schema.categories.deletedAt))
    .orderBy(asc(schema.categories.sortOrder), asc(schema.categories.name))
    .all()
    .filter((c) => includeHidden || !c.hidden);

  return groups.map((g) => ({
    ...g,
    categories: categories.filter((c) => c.groupId === g.id),
  }));
}
