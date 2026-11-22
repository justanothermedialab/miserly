/**
 * instance.ts — the running app's single database handle.
 * ============================================================================
 * The ONE place the running app opens the database: lazily resolves `dbPath()`,
 * runs any pending migrations, opens the connection, and caches it for the
 * lifetime of the process. Tests / the e2e `globalSetup` open their OWN handle
 * directly (via `createDb` + `runMigrations`) to seed — they never go through
 * this singleton, since they don't share the app process.
 * ============================================================================
 */
import { dbPath } from '../config';
import { runMigrations } from './migrate';
import { createDb } from './client';
import type { Db } from './client';

let cached: Db | undefined;

/** The app's db handle — same instance on every call within this process. */
export function getDb(): Db {
  if (!cached) {
    const path = dbPath();
    runMigrations(path);
    cached = createDb(path);
  }
  return cached;
}

/**
 * Close the database at shutdown. Closing the last connection folds the
 * write-ahead file into the database and removes it, so after a stop the volume holds one
 * complete `miserly.db`. A no-op when it was never opened or is closed already.
 */
export function closeDb(): void {
  if (cached?.sqlite.open) cached.sqlite.close();
}
