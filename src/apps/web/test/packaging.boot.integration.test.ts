/**
 * packaging.boot.integration.test.ts — the M12 packaging CONTRACT (browserless).
 * ============================================================================
 * Both deployment modes (Docker, Electron) wrap the SAME artifact: the
 * adapter-node server started by `node build/index.js`, configured entirely
 * through env vars. This test spawns exactly that and proves the contract every
 * wrapper depends on, WITHOUT a browser (RAM-safe on the 8GB box):
 *   1. It boots under MISERLY_DB_PATH/HOST/PORT/ORIGIN overrides and serves.
 *   2. A fresh instance redirects to the first-run /setup ceremony.
 *   3. It created + migrated the SQLite file at MISERLY_DB_PATH.
 *   4. CSRF/ORIGIN wiring is correct: a mismatched-Origin form POST is REJECTED
 *      (403) while a matching-Origin POST is ACCEPTED — the single most common
 *      packaging bug (a missing/wrong ORIGIN silently 403s every form action).
 *
 * Guarded on the presence of build/ so `pnpm test` stays green before a build;
 * `pnpm build` first (CI does) to actually exercise it.
 * ============================================================================
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildEntry = path.join(webRoot, 'build', 'index.js');
const migrationsDir = path.join(webRoot, 'drizzle');
const hasBuild = fs.existsSync(buildEntry);

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await fetch(url, { redirect: 'manual' });
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`server never came up at ${url}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

describe.skipIf(!hasBuild)('packaging: `node build/index.js` boot contract', () => {
  let child: ChildProcess;
  let tmpDir: string;
  let dbPath: string;
  let origin: string;

  beforeAll(async () => {
    const port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miserly-boot-'));
    dbPath = path.join(tmpDir, 'miserly.db');

    child = spawn(process.execPath, [buildEntry], {
      env: {
        ...process.env,
        MISERLY_DB_PATH: dbPath,
        MISERLY_MIGRATIONS_DIR: migrationsDir,
        HOST: '127.0.0.1',
        PORT: String(port),
        ORIGIN: origin,
        NODE_ENV: 'production',
      },
      stdio: 'ignore',
    });

    await waitForHttp(origin);
  }, 30000);

  afterAll(async () => {
    // Wait for the server to actually exit (release the SQLite file handle)
    // before removing the temp dir — on Windows an immediate rmSync races the
    // still-open handle and throws EPERM. Tolerate a residual lock regardless.
    if (child && child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
        setTimeout(resolve, 3000);
      });
    }
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* a lingering handle on a throwaway temp dir; the OS will reap it */
    }
  });

  it('a fresh instance redirects to the /setup ceremony', async () => {
    const res = await fetch(origin + '/', { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/setup');
  });

  it('created and migrated the SQLite file at MISERLY_DB_PATH', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    try {
      const version = db.pragma('user_version', { simple: true }) as number;
      expect(version).toBeGreaterThan(0); // migrations ran on boot
    } finally {
      db.close();
    }
  });

  it('enforces the Origin/CSRF check, and accepts a matching Origin (the ORIGIN wiring)', async () => {
    const body = new URLSearchParams({
      username: 'admin',
      displayName: 'Admin',
      password: 'a-strong-password',
    });

    // Cross-origin form POST must be forbidden — proves CSRF is actually ON.
    const bad = await fetch(origin + '/setup', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example' },
      body,
    });
    expect(bad.status).toBe(403);

    // Same-origin POST must NOT be rejected — the shipped ORIGIN lets forms work.
    // (SvelteKit answers a script-initiated form POST with a 200 action-result,
    // not a raw 303 — either way it's accepted and processed, not an error.)
    const good = await fetch(origin + '/setup', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body,
    });
    expect(good.status).not.toBe(403);
    expect(good.status).toBeLessThan(400);

    // The ceremony actually ran: an admin now exists, so an unauthenticated GET /
    // no longer routes to /setup but to /signin.
    const after = await fetch(origin + '/', { redirect: 'manual' });
    expect(after.status).toBe(303);
    expect(after.headers.get('location')).toContain('/signin');
  });
});
