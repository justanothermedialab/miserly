/**
 * migrate.ts — forward-only, user_version-keyed migration runner.
 * ============================================================================
 * The safety protocol:
 *   - Forward-only, keyed to `PRAGMA user_version` (NOT drizzle-kit's own
 *     __drizzle_migrations bookkeeping table — this runner owns versioning).
 *   - Transactional: all pending migrations apply in ONE better-sqlite3
 *     transaction; any failure rolls the whole batch back (SQLite DDL and
 *     `PRAGMA user_version` writes are both transactional).
 *   - Backup-before-migrate: a real file db is copied to `${dbPath}.bak` first.
 *   - Restore-on-failure: on ANY error the connection is closed and the backup
 *     is copied back over `dbPath`, so a crash never leaves a half-migrated
 *     file. The `.bak` is removed on success and DELIBERATELY LEFT on failure
 *     (a surviving backup is the crash-recovery artifact you want).
 *
 * The migrations source is injectable (`migrationsDir`) purely so the failure
 * path is testable with a deliberately-broken fixture.
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * Locate the generated-SQL directory. In dev/test this module lives at
 * apps/web/src/lib/server/db/ and the migrations are four levels up
 * (apps/web/drizzle). But once adapter-node BUNDLES this into build/server/
 * chunks/, that relative path breaks — the packaged server (`node build/index.js`,
 * what BOTH Docker and Electron run) can't find its migrations. So resolve, in
 * order: an explicit `MISERLY_MIGRATIONS_DIR` (set by the packaging wrappers,
 * mirroring MISERLY_DB_PATH), then the source-relative default, then
 * `<cwd>/drizzle`. Evaluated per-call so wrappers can set the env before use.
 */
function defaultMigrationsDir(): string {
  const override = process.env.MISERLY_MIGRATIONS_DIR;
  if (override && override.length > 0) return path.resolve(override);
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'drizzle'),
    path.resolve(process.cwd(), 'drizzle'),
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0]!;
}

/** drizzle-kit's inter-statement marker. Files may also contain no marker at all. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** The ordered `.sql` migration files in `dir`, sorted by numeric filename prefix. */
export function migrationFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => numericPrefix(a) - numericPrefix(b));
}

function numericPrefix(filename: string): number {
  const match = /^(\d+)/.exec(filename);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** Split one migration file's contents into individual executable statements. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * All pending-agnostic statements for a migrations dir, in file then in-file
 * order. Exposed so tests (and the `:memory:` setup path) can apply the exact
 * generated schema onto an existing connection without the version/backup
 * machinery.
 */
export function allStatements(migrationsDir: string = defaultMigrationsDir()): string[] {
  return migrationFiles(migrationsDir).flatMap((f) =>
    splitStatements(fs.readFileSync(path.join(migrationsDir, f), 'utf8')),
  );
}

export interface MigrationResult {
  /** How many migration files were newly applied this run. */
  readonly applied: number;
  /** The `user_version` after the run (== total migration count once caught up). */
  readonly version: number;
}

/**
 * Apply all pending migrations to the db at `dbPath`. Returns `{ applied, version }`.
 * `applied` is 0 when the db is already at or beyond the latest version.
 */
export function runMigrations(
  dbPath: string,
  migrationsDir: string = defaultMigrationsDir(),
): MigrationResult {
  const files = migrationFiles(migrationsDir);
  const total = files.length;

  const sqlite = new Database(dbPath);
  const current = sqlite.pragma('user_version', { simple: true }) as number;

  if (current >= total) {
    sqlite.close();
    return { applied: 0, version: current };
  }

  const backupPath = `${dbPath}.bak`;
  const backupMade = dbPath !== ':memory:';
  if (backupMade) {
    // A real db may be in WAL mode (client.ts sets it), so uncommitted pages can
    // live in the `-wal` sidecar. Fold them into the main file first, so the
    // single-file backup below is a byte-complete snapshot of committed state.
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(dbPath, backupPath);
  }

  try {
    let applied = 0;
    const apply = sqlite.transaction(() => {
      for (let i = 0; i < total; i++) {
        const ordinal = i + 1; // 1-based; user_version counts applied migrations
        if (ordinal <= current) continue;
        const file = files[i]!;
        const statements = splitStatements(
          fs.readFileSync(path.join(migrationsDir, file), 'utf8'),
        );
        for (const stmt of statements) {
          sqlite.exec(stmt);
        }
        applied++;
      }
      sqlite.pragma(`user_version = ${total}`);
    });
    apply(); // throws + auto-rolls-back on any error

    const version = sqlite.pragma('user_version', { simple: true }) as number;
    sqlite.close();
    if (backupMade) {
      fs.rmSync(backupPath, { force: true });
    }
    return { applied, version };
  } catch (err) {
    // Transaction already rolled back; close the handle, then byte-restore the
    // pre-migration file from the backup and leave the backup as evidence.
    sqlite.close();
    if (backupMade && fs.existsSync(backupPath)) {
      // Clear any WAL sidecars so they can't re-apply over the restored file.
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      fs.copyFileSync(backupPath, dbPath);
    }
    throw err;
  }
}
