/**
 * electron-smoke.spec.ts — drive the REAL PACKAGED desktop app end-to-end.
 * ============================================================================
 * This is the deploy-mode verification the M12 packaging never actually ran: it
 * launches the built exe
 * (apps/desktop/dist/win-unpacked/Miserly.exe), which boots the embedded
 * SvelteKit + better-sqlite3 server on 127.0.0.1 (main.cjs) — proving the whole
 * offline desktop stack, native Electron-ABI SQLite included, actually works:
 *   1. the window renders the app (assets load — no blank/error screen);
 *   2. the first-run "create your Circle" ceremony writes to the userData DB;
 *   3. after setup the app lands on the dashboard (authenticated);
 *   4. relaunching against the SAME userData is NOT first-run → data PERSISTED
 *      (the local SQLite file is the system of record).
 * A fresh --user-data-dir per run keeps it deterministic and side-effect-free.
 * ============================================================================
 */
import { test, expect, _electron } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.resolve(HERE, '../../desktop/dist/win-unpacked/Miserly.exe');

test('packaged Electron app: boots embedded server, first-run works, data persists', async () => {
	expect(fs.existsSync(EXE), `built desktop exe should exist at ${EXE} (run: pnpm --filter @miserly/desktop dist)`).toBeTruthy();

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miserly-electron-'));
	const dbPath = path.join(userDataDir, 'miserly.db');

	// If the shell has ELECTRON_RUN_AS_NODE set, every Electron binary runs as
	// plain Node (rejecting Chromium flags) and Playwright can't attach — strip it.
	// (Build a string-only env: process.env values are string | undefined.)
	const electronEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) electronEnv[k] = v;
	delete electronEnv.ELECTRON_RUN_AS_NODE;

	// ── Launch 1: fresh userData → the first-run ceremony ──────────────────────
	const launchArgs = [`--user-data-dir=${userDataDir}`];
	let app = await _electron.launch({ executablePath: EXE, args: launchArgs, env: electronEnv, timeout: 60_000 });
	let win = await app.firstWindow();
	await win.waitForLoadState('domcontentloaded');

	// The window rendered the real app (assets loaded), on the first-run screen.
	const createBtn = win.getByRole('button', { name: /Create login/i });
	await expect(createBtn).toBeVisible({ timeout: 30_000 });

	// Create the admin + Circle (writes to the userData SQLite DB).
	await win.locator('input[name="username"]').fill('alice');
	await win.locator('input[name="password"]').fill('desktop-demo-8'); // ≥ MIN_PASSWORD_LENGTH (10)
	await win.locator('input[name="circleName"]').fill('Desktop Test Household');
	await createBtn.click();

	// Setup redirects (303) to the dashboard → the authenticated chrome appears
	// (the TopBar "Add" quick-add button only renders when signed in).
	await expect(win.getByRole('button', { name: 'Add' })).toBeVisible({ timeout: 30_000 });
	expect(fs.existsSync(dbPath), 'the SQLite system-of-record should be written to userData').toBeTruthy();
	await app.close();

	// ── Launch 2: SAME userData → NOT first-run (data persisted) ───────────────
	app = await _electron.launch({ executablePath: EXE, args: launchArgs, env: electronEnv, timeout: 60_000 });
	win = await app.firstWindow();
	await win.waitForLoadState('domcontentloaded');
	// The Circle already exists, so the first-run "Create login" form must be gone.
	await expect(win.getByRole('button', { name: /Create login/i })).toHaveCount(0, { timeout: 30_000 });
	await app.close();
});
