/**
 * migration.test.ts — the M3 migration-SAFETY proof.
 * ============================================================================
 * Proves the runner's four guarantees:
 * forward-only + keyed to PRAGMA user_version; transactional; backup-before-
 * migrate; and restore-on-failure (a failed migration leaves the ORIGINAL file,
 * never a half-migrated one). The failure path is exercised with a deliberately
 * broken fixture migration and asserts BOTH no data loss and no partial DDL.
 * ============================================================================
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createDb } from '../src/lib/server/db/client';
import { runMigrations, migrationFiles, splitStatements } from '../src/lib/server/db/migrate';

const here = path.dirname(fileURLToPath(import.meta.url));
const BROKEN_DIR = path.join(here, 'fixtures', 'broken-migrations');

/** The real generated-migrations dir; TOTAL tracks the count so this suite stays
 *  correct as migrations accrue (0000 at M3, +0001 auth columns at M4, …). */
const REAL_DIR = path.join(here, '..', 'drizzle');
const TOTAL = migrationFiles(REAL_DIR).length;

const created: string[] = [];
/** A migrations dir holding only the first `n` real files: a file as it was before migration n. */
function migrationsUpTo(n: number): string {
  const dir = path.join(os.tmpdir(), `miserly-migdir-${randomUUID()}`);
  fs.mkdirSync(dir);
  for (const f of migrationFiles(REAL_DIR).slice(0, n)) fs.copyFileSync(path.join(REAL_DIR, f), path.join(dir, f));
  created.push(dir);
  return dir;
}
function tmpDbPath(): string {
  const p = path.join(os.tmpdir(), `miserly-mig-${randomUUID()}.db`);
  created.push(p);
  return p;
}

afterEach(() => {
  for (const p of created.splice(0)) {
    for (const suffix of ['', '.bak', '-wal', '-shm']) {
      fs.rmSync(p + suffix, { force: true, recursive: true });
    }
  }
});

/** Table names present in a db file (via a throwaway read connection). */
function tableNames(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

function userVersion(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return db.pragma('user_version', { simple: true }) as number;
  } finally {
    db.close();
  }
}

/** Column names on a table (via a throwaway read connection). */
function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath);
  try {
    const rows = db.pragma(`table_info(${table})`) as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

describe('migration: forward-only, user_version-keyed', () => {
  it('applies ALL migrations forward and bumps user_version to the total', () => {
    const dbPath = tmpDbPath();
    const result = runMigrations(dbPath);

    // Count-aware: applies every pending file (0000 schema + 0001 auth columns).
    expect(result.applied).toBe(TOTAL);
    expect(result.version).toBe(TOTAL);
    expect(userVersion(dbPath)).toBe(TOTAL);

    const names = tableNames(dbPath);
    for (const t of ['users', 'accounts', 'transactions', 'account_members', 'categories', 'payees', 'rates']) {
      expect(names).toContain(t);
    }
    // The M4 migration (0001) actually ran: the auth columns exist on `users`.
    const userCols = columnNames(dbPath, 'users');
    for (const c of ['username', 'role', 'must_change_password']) {
      expect(userCols).toContain(c);
    }
    expect(columnNames(dbPath, 'sessions')).toContain('last_used_at');
    // The M6 migration (0003) actually ran: the notes column exists on `transactions`.
    expect(columnNames(dbPath, 'transactions')).toContain('notes');
    // Backup is cleaned up on success.
    expect(fs.existsSync(`${dbPath}.bak`)).toBe(false);
  });

  it('0010 adds the dated account_shares table; its CHECK refuses a share outside 0 to 10,000 bp', () => {
    const dbPath = tmpDbPath();
    runMigrations(dbPath);
    expect(tableNames(dbPath)).toContain('account_shares');
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = OFF'); // the CHECK alone, without seeding an account and users
      const put = db.prepare(
        'INSERT INTO account_shares (account_id, user_id, effective_from, share_bp) VALUES (?, ?, ?, ?)',
      );
      put.run('a1', 'u1', '2026-10-01', 0);
      put.run('a1', 'u2', '2026-10-01', 10000);
      expect(() => put.run('a1', 'u3', '2026-10-01', 10001)).toThrow(/CHECK constraint failed/);
      expect(() => put.run('a1', 'u4', '2026-10-01', -1)).toThrow(/CHECK constraint failed/);
      // One row per holder per date.
      expect(() => put.run('a1', 'u1', '2026-10-01', 5000)).toThrow(/UNIQUE|PRIMARY KEY/);
    } finally {
      db.close();
    }
  });

  it('0011 adds one "Other" to every group but Adjustments, once, at the end, leaving what is there', () => {
    const dbPath = tmpDbPath();
    runMigrations(dbPath, migrationsUpTo(11)); // a file from before 0011
    const db = new Database(dbPath);
    try {
      const group = db.prepare('INSERT INTO category_groups (id, name, kind, sort_order) VALUES (?, ?, ?, ?)');
      const cat = db.prepare('INSERT INTO categories (id, group_id, name, sort_order) VALUES (?, ?, ?, ?)');
      group.run('g-inc', 'Income', 'income', 0);
      cat.run('c-sal', 'g-inc', 'Salary', 0);
      cat.run('c-int', 'g-inc', 'Interest', 1);
      group.run('g-ess', 'Essentials', 'spending', 1);
      cat.run('c-rent', 'g-ess', 'Rent', 0);
      group.run('g-mine', 'Kids', 'spending', 2);
      cat.run('c-oth', 'g-mine', 'other', 0); // already has one, in any case
      group.run('g-adj', 'Adjustments', 'neutral', 3);
      cat.run('sys-balance-adjustment', 'g-adj', 'Balance adjustment', 0);
      group.run('g-empty', 'New group', 'spending', 4);
    } finally {
      db.close();
    }
    expect(runMigrations(dbPath).applied).toBe(TOTAL - 11);
    const after = new Database(dbPath);
    try {
      const others = after
        .prepare("SELECT group_id AS g, sort_order AS s FROM categories WHERE lower(name) = 'other' ORDER BY group_id")
        .all() as { g: string; s: number }[];
      expect(others).toEqual([
        { g: 'g-empty', s: 0 },
        { g: 'g-ess', s: 1 },
        { g: 'g-inc', s: 2 },
        { g: 'g-mine', s: 0 },
      ]);
      expect((after.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n).toBe(5 + 3);
    } finally {
      after.close();
    }
  });

  it('0012 adds "Counts as return" (on for the seeded Interest, Dividends, Balance adjustment) and moves the seeded Investments group to its own kind', () => {
    const dbPath = tmpDbPath();
    runMigrations(dbPath, migrationsUpTo(12)); // a file from before 0012
    const db = new Database(dbPath);
    try {
      const group = db.prepare('INSERT INTO category_groups (id, name, kind, sort_order, deleted_at) VALUES (?, ?, ?, ?, ?)');
      const cat = db.prepare('INSERT INTO categories (id, group_id, name, sort_order) VALUES (?, ?, ?, ?)');
      group.run('g-inc', 'Income', 'income', 0, null);
      cat.run('c-sal', 'g-inc', 'Salary', 0);
      cat.run('c-int', 'g-inc', 'Interest', 1);
      cat.run('c-div', 'g-inc', 'dividends', 2);
      group.run('g-ess', 'Essentials', 'spending', 1, null);
      cat.run('c-loan-int', 'g-ess', 'Interest', 0); // a spending "Interest" (a loan's) stays off
      group.run('g-inv', 'Investments', 'neutral', 2, null);
      cat.run('c-sip', 'g-inv', 'SIP', 0);
      group.run('g-lent', 'Owed to me', 'neutral', 3, null); // the person's own neutral group stays
      group.run('g-old', 'investments', 'neutral', 4, '2026-01-01'); // a deleted one is left as it was
      group.run('g-adj', 'Adjustments', 'neutral', 5, null);
      cat.run('sys-balance-adjustment', 'g-adj', 'Balance adjustment', 0);
    } finally {
      db.close();
    }
    expect(runMigrations(dbPath).applied).toBe(TOTAL - 12);
    const after = new Database(dbPath);
    try {
      const on = after.prepare('SELECT id FROM categories WHERE counts_as_return = 1 ORDER BY id').all() as { id: string }[];
      expect(on.map((r) => r.id)).toEqual(['c-div', 'c-int', 'sys-balance-adjustment']);
      const kinds = after.prepare('SELECT id, kind FROM category_groups ORDER BY id').all() as { id: string; kind: string }[];
      expect(Object.fromEntries(kinds.map((k) => [k.id, k.kind]))).toEqual({
        'g-adj': 'neutral', 'g-ess': 'spending', 'g-inc': 'income', 'g-inv': 'investments', 'g-lent': 'neutral', 'g-old': 'neutral',
      });
      // A category added later starts with the switch off.
      after.prepare("INSERT INTO categories (id, group_id, name) VALUES ('c-new', 'g-ess', 'Fuel')").run();
      expect((after.prepare("SELECT counts_as_return AS v FROM categories WHERE id = 'c-new'").get() as { v: number }).v).toBe(0);
    } finally {
      after.close();
    }
  });

  it('0013 adds the holders\' stretches (account_holder_periods) without touching a grant from before it', () => {
    const dbPath = tmpDbPath();
    runMigrations(dbPath, migrationsUpTo(13)); // a file from before 0013
    const db = new Database(dbPath);
    try {
      db.prepare("INSERT INTO users (id, username, display_name, role) VALUES ('a', 'a', 'A', 'admin'), ('b', 'b', 'B', 'member')").run();
      db.prepare("INSERT INTO accounts (id, owner_id, name, type, currency) VALUES ('j', 'a', 'Joint', 'bank', 'INR')").run();
      db.prepare("INSERT INTO account_members (account_id, user_id) VALUES ('j', 'b')").run();
    } finally {
      db.close();
    }
    expect(runMigrations(dbPath).applied).toBe(TOTAL - 13);
    expect(columnNames(dbPath, 'account_holder_periods')).toEqual(['account_id', 'user_id', 'from_date', 'to_date', 'created_at', 'updated_at']);
    const after = new Database(dbPath);
    try {
      // No backfill: the old grant has no row and counts as held since the start (visibility.ts).
      expect(after.prepare('SELECT COUNT(*) AS n FROM account_holder_periods').get()).toEqual({ n: 0 });
      expect(after.prepare('SELECT COUNT(*) AS n FROM account_members WHERE deleted_at IS NULL').get()).toEqual({ n: 1 });
      const ins = after.prepare("INSERT INTO account_holder_periods (account_id, user_id, from_date, to_date) VALUES ('j', 'b', ?, ?)");
      ins.run('2026-01-01', '2026-02-01');
      ins.run('2026-03-01', null);
      expect(() => ins.run('2026-05-01', '2026-05-01')).toThrow(/CHECK/); // a stretch ends after it starts
      expect(() => ins.run('2026-03-01', '2026-04-01')).toThrow(/UNIQUE|PRIMARY/);
    } finally {
      after.close();
    }
  });

  it("0014 adds an account's parent (an EPF's EPS) without touching existing accounts", () => {
    const dbPath = tmpDbPath();
    runMigrations(dbPath, migrationsUpTo(14)); // a file from before 0014
    const db = new Database(dbPath);
    try {
      db.prepare("INSERT INTO users (id, username, display_name, role) VALUES ('a', 'a', 'A', 'admin')").run();
      db.prepare("INSERT INTO accounts (id, owner_id, name, type, currency) VALUES ('x', 'a', 'HDFC', 'bank', 'INR')").run();
    } finally {
      db.close();
    }
    expect(runMigrations(dbPath).applied).toBe(TOTAL - 14);
    expect(columnNames(dbPath, 'accounts')).toContain('parent_account_id');
    const after = new Database(dbPath);
    try {
      expect(after.prepare("SELECT parent_account_id AS p FROM accounts WHERE id = 'x'").get()).toEqual({ p: null });
      after.prepare("INSERT INTO accounts (id, owner_id, name, type, currency, parent_account_id) VALUES ('e', 'a', 'EPF', 'epf', 'INR', NULL), ('s', 'a', 'EPS of EPF', 'eps', 'INR', 'e')").run();
      expect(after.prepare("SELECT id FROM accounts WHERE parent_account_id = 'e'").all()).toEqual([{ id: 's' }]);
    } finally {
      after.close();
    }
  });

  it('0015 adds the import log (F4) without touching existing rows', () => {
    const dbPath = tmpDbPath();
    runMigrations(dbPath, migrationsUpTo(15)); // a file from before 0015
    const db = new Database(dbPath);
    try {
      db.prepare("INSERT INTO users (id, username, display_name, role) VALUES ('a', 'a', 'A', 'admin')").run();
      db.prepare("INSERT INTO accounts (id, owner_id, name, type, currency) VALUES ('x', 'a', 'HDFC', 'bank', 'INR')").run();
    } finally {
      db.close();
    }
    expect(runMigrations(dbPath).applied).toBe(TOTAL - 15);
    expect(columnNames(dbPath, 'imports')).toEqual(expect.arrayContaining(['user_id', 'file_name', 'budget_id', 'undone_at']));
    expect(columnNames(dbPath, 'import_items')).toEqual(['import_id', 'kind', 'our_id', 'actual_id', 'created']);
    const after = new Database(dbPath);
    try {
      expect(after.prepare("SELECT name FROM accounts WHERE id = 'x'").get()).toEqual({ name: 'HDFC' });
      after.prepare("INSERT INTO imports (id, user_id, source, file_name) VALUES ('i', 'a', 'actual', 'b.zip')").run();
      const item = after.prepare('INSERT INTO import_items (import_id, kind, our_id, actual_id) VALUES (?, ?, ?, ?)');
      item.run('i', 'account', 'x', 'act-1');
      expect(() => item.run('i', 'budget', 'y', 'act-2')).toThrow(/CHECK/);
    } finally {
      after.close();
    }
  });

  it('0016 adds users.password_reset_at (S4) without touching existing rows', () => {
    const dbPath = tmpDbPath();
    runMigrations(dbPath, migrationsUpTo(16)); // a file from before 0016
    const db = new Database(dbPath);
    try {
      db.prepare("INSERT INTO users (id, username, display_name, role) VALUES ('a', 'a', 'A', 'admin')").run();
    } finally {
      db.close();
    }
    expect(runMigrations(dbPath).applied).toBe(TOTAL - 16);
    expect(columnNames(dbPath, 'users')).toContain('password_reset_at');
    const after = new Database(dbPath);
    try {
      expect(after.prepare("SELECT username, password_reset_at AS r FROM users WHERE id = 'a'").get()).toEqual({ username: 'a', r: null });
    } finally {
      after.close();
    }
  });

  it('is a no-op when the db is already current', () => {
    const dbPath = tmpDbPath();
    runMigrations(dbPath);
    const again = runMigrations(dbPath);
    expect(again.applied).toBe(0);
    expect(again.version).toBe(TOTAL);
  });
});

describe('migration: backup-before-migrate + restore-on-failure', () => {
  it('a failing migration restores the pre-migration file (no data loss, no partial DDL)', () => {
    const dbPath = tmpDbPath();

    // Seed to v1 with a known row, decoupled from the REAL migration count:
    // apply ONLY the broken dir's own valid 0000_init (its schema), stamp
    // user_version=1, insert the row (WAL mode, via the real client — this also
    // exercises the runner's pre-backup WAL checkpoint). The broken dir's 0000 is
    // identical schema, so when the runner later skips it (ordinal 1 <= current 1)
    // and attempts 0001_bad, the failure/restore is what's under test.
    const initFile = migrationFiles(BROKEN_DIR)[0]!; // 0000_init.sql
    const initSql = fs.readFileSync(path.join(BROKEN_DIR, initFile), 'utf8');
    const seed = createDb(dbPath);
    for (const stmt of splitStatements(initSql)) seed.sqlite.exec(stmt);
    seed.sqlite.pragma('user_version = 1');
    seed.sqlite
      .prepare(`INSERT INTO users (id, display_name) VALUES (?, ?)`)
      .run('keep-me', 'Survivor');
    seed.sqlite.close();

    expect(userVersion(dbPath)).toBe(1);

    // The broken fixture dir has 2 files (total=2); with current=1 the runner
    // attempts only 0001_bad.sql, which fails partway.
    expect(() => runMigrations(dbPath, BROKEN_DIR)).toThrow();

    // No data loss: the seeded row survived.
    const db = new Database(dbPath);
    try {
      const row = db.prepare(`SELECT id FROM users WHERE id = ?`).get('keep-me') as
        | { id: string }
        | undefined;
      expect(row?.id).toBe('keep-me');
    } finally {
      db.close();
    }

    // No partial DDL: the table the broken migration tried to create is absent.
    expect(tableNames(dbPath)).not.toContain('should_not_exist');
    // user_version unchanged.
    expect(userVersion(dbPath)).toBe(1);
    // The backup is deliberately left behind as a crash-recovery artifact.
    expect(fs.existsSync(`${dbPath}.bak`)).toBe(true);
  });
});
