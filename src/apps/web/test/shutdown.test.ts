/**
 * shutdown.test.ts: closing cleanly. A stop that became a kill could leave recent writes in
 * `miserly.db-wal`, which a copy of `miserly.db` alone missed. The server now closes the database
 * when adapter-node says it has stopped (`sveltekit:shutdown`), which folds the write-ahead file in.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DB_PATH = path.join(os.tmpdir(), `miserly-shutdown-${randomUUID()}.db`);
process.env.MISERLY_DB_PATH = DB_PATH;

import { getDb } from '../src/lib/server/db/instance';
import { init } from '../src/hooks.server';
import { createAdmin } from '../src/lib/server/auth/users';

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
});

describe('the database at shutdown', () => {
  it('is closed on sveltekit:shutdown, leaving one complete file', async () => {
    await init();
    await createAdmin(getDb().db, { username: 'alice', displayName: 'Alice', password: 'alice-password-123' });
    expect(fs.existsSync(`${DB_PATH}-wal`)).toBe(true);
    // What adapter-node emits once its server has closed.
    (process.emit as (event: string, ...args: unknown[]) => boolean)('sveltekit:shutdown', 'SIGTERM');
    expect(getDb().sqlite.open).toBe(false);
    expect(fs.existsSync(`${DB_PATH}-wal`)).toBe(false);
    const Database = (await import('better-sqlite3')).default;
    const reopened = new Database(DB_PATH, { readonly: true });
    expect((reopened.prepare('SELECT count(*) AS c FROM users').get() as { c: number }).c).toBe(1);
    reopened.close();
  });
});
