/**
 * category-rules.ts — what "a category can be picked" means, in one place (N-12).
 * ============================================================================
 * Hidden means the category OR its group (F2 RD5): a category in a hidden group is out of every
 * picker, refused on a save (create, edit, bulk, a transfer, a payee's default), and never
 * suggested or remembered. Before, each check read only the category's own flag, so a hidden
 * group's categories could still be picked, and a payee's remembered category hidden later filled
 * a field the picker showed blank and the save failed (N-12).
 * ============================================================================
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from './db/schema';
import type { Db } from './db/client';

/** A join or WHERE condition: `categories` is live, not hidden, in a live group that isn't hidden. */
export const categoryPickable = sql`(${schema.categories.deletedAt} IS NULL AND ${schema.categories.hidden} = 0 AND EXISTS (
  SELECT 1 FROM category_groups g WHERE g.id = ${schema.categories.groupId} AND g.deleted_at IS NULL AND g.hidden = 0))`;

/** Whether a category can be picked for a row (see the header). */
export function isPickableCategory(db: Db['db'], categoryId: string): boolean {
  return (
    db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(eq(schema.categories.id, categoryId), isNull(schema.categories.deletedAt), categoryPickable))
      .get() !== undefined
  );
}
