/**
 * account-names.ts — the names two accounts the viewer sees share across sections.
 * ============================================================================
 * Reads that name an account without the account list at hand (the register's transfer text, the
 * inbox, the reports' drill) take the set here and pass it to `accountLabel` / `sectionedName`, so
 * "HDFC (Mutual funds)" reads the same on every screen. Viewer-scoped through `accountsVisibleTo`
 * (P0: a member's private account never makes another member's name read differently).
 * ============================================================================
 */
import { and, inArray, isNull } from 'drizzle-orm';
import * as schema from './db/schema';
import type { Db } from './db/client';
import { accountsVisibleTo } from './visibility';
import { sharedNames } from '../transfer-targets';

type AppDb = Db['db'];

/** The shared names among `ids`, which must be the viewer's visible set. */
export function sharedNamesOf(db: AppDb, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  return sharedNames(
    db
      .select({ name: schema.accounts.name, type: schema.accounts.type })
      .from(schema.accounts)
      .where(and(isNull(schema.accounts.deletedAt), inArray(schema.accounts.id, [...ids])))
      .all(),
  );
}

export async function visibleSharedNames(database: Db, userId: string): Promise<Set<string>> {
  return sharedNamesOf(database.db, await accountsVisibleTo(database.db, userId));
}
