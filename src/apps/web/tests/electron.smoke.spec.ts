/**
 * electron.smoke.spec.ts — the Electron desktop shell actually boots (M12).
 * ============================================================================
 * Drives the REAL Electron runtime (not a stray Chromium) via Playwright's
 * `_electron` launcher: it starts apps/desktop, which boots the embedded server
 * on 127.0.0.1 in a temp userData dir, then asserts the first window lands on
 * the first-run /setup ceremony (fresh instance → no admin → redirect).
 *
 * Skipped unless the self-contained server tree has been prepared
 * (`pnpm --filter @miserly/desktop prepare:server`) AND electron is installed —
 * so `pnpm test:e2e` never hard-fails on a machine that hasn't built desktop.
 * This spec does NOT use the `page` fixture, so no Edge browser is launched for
 * it (the global webServer still starts, harmlessly).
 * ============================================================================
 */
import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const desktopDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'desktop',
);
const serverEntry = path.join(desktopDir, 'server', 'build', 'index.js');

/** Resolve the electron binary from the desktop package (not from apps/web). */
function resolveElectron(): string | null {
	try {
		const req = createRequire(path.join(desktopDir, 'package.json'));
		return req('electron') as string;
	} catch {
		return null;
	}
}

test('the desktop shell boots and shows the first-run setup ceremony', async () => {
	const electronPath = resolveElectron();
	test.skip(
		!fs.existsSync(serverEntry) || electronPath === null,
		'desktop server tree not prepared or electron not installed — run `pnpm --filter @miserly/desktop prepare:server`',
	);

	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miserly-electron-'));
	// Some runners (Electron-hosted terminals, certain CI) inherit
	// ELECTRON_RUN_AS_NODE=1, which makes the launched electron run as plain Node
	// and disables the built-in `electron` API — strip it so the shell boots real.
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	delete env.ELECTRON_RUN_AS_NODE;
	const app = await electron.launch({
		executablePath: electronPath!,
		args: [desktopDir, `--user-data-dir=${userDataDir}`],
		env,
	});

	try {
		const window = await app.firstWindow();
		await window.waitForLoadState('networkidle');
		// Fresh userData → no admin → the shell lands on /setup.
		expect(window.url()).toContain('/setup');
	} finally {
		await app.close();
		fs.rmSync(userDataDir, { recursive: true, force: true });
	}
});
