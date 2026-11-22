/**
 * e2e-env.ts — the ONE computed value shared between `playwright.config.ts`
 * (which sets `MISERLY_DB_PATH` for the spawned `webServer` process) and
 * `tests/global-setup.ts` (which seeds that same file before any test runs).
 * A random per-run path avoids collisions across runs/workers without needing
 * any cleanup step.
 *
 * CRITICAL: Playwright transpiles/loads `playwright.config.ts` and
 * `tests/global-setup.ts` through separate module pipelines, so this file can be
 * EVALUATED MORE THAN ONCE in the same main process. A bare `randomUUID()` would
 * then hand the config (→ webServer env) and globalSetup (→ the seeder) DIFFERENT
 * paths, so the server would open an empty DB and every login/visibility check
 * would fail. We therefore memoize the chosen path in `process.env` on first
 * eval and reuse it on every subsequent eval within the process.
 */
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const ENV_KEY = 'MISERLY_DB_PATH';

function resolveE2eDbPath(): string {
  const existing = process.env[ENV_KEY];
  if (existing && existing.length > 0) return existing;
  const chosen = path.join(os.tmpdir(), `miserly-e2e-${randomUUID()}.db`);
  process.env[ENV_KEY] = chosen; // memoize for every later eval in THIS process
  return chosen;
}

export const E2E_DB_PATH = resolveE2eDbPath();
