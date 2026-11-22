/**
 * client.ts — the better-sqlite3 + Drizzle connection factory.
 * ============================================================================
 * Opens a single better-sqlite3 handle and wraps it with Drizzle (typed to the
 * frozen `schema`). The raw `sqlite` handle is exposed alongside `db` because
 * the crown-jewel running-balance window function (balances.ts) and the
 * migration runner (migrate.ts) speak raw SQL on the connection, not the ORM.
 *
 * PRAGMAs: WAL for durability/concurrency on a real file (a no-op for an
 * in-memory db, which has no file to journal), and foreign_keys = ON so the
 * Circle FK graph (owner_id / account_members / entered_by / transfer_partner)
 * is actually enforced.
 * ============================================================================
 */
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export interface Db {
  readonly sqlite: BetterSqlite3Database;
  readonly db: BetterSQLite3Database<typeof schema>;
}

/**
 * Open a database at `path` (`':memory:'` for tests, a file path otherwise)
 * and return both the raw better-sqlite3 handle and the Drizzle wrapper.
 */
export function createDb(path: string): Db {
  const sqlite = new Database(path);

  // WAL has no meaning for an in-memory db (no file); setting it is harmless
  // but we skip it to avoid a spurious journal-mode change on ':memory:'.
  if (path !== ':memory:') {
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
