import { defineConfig } from '@playwright/test';

// ── Electron end-to-end config ───────────────────────────────────────────────
// Drives the ACTUAL PACKAGED desktop app (apps/desktop/dist/win-unpacked/…exe)
// via Playwright's Electron support. There is NO webServer here — the Electron
// app boots its own embedded SvelteKit server on 127.0.0.1 (main.cjs); the test
// launches the exe, waits for the window, and verifies first-run + persistence.
// Run: pnpm exec playwright test --config playwright.electron.config.ts
export default defineConfig({
	testDir: 'tests',
	testMatch: /electron-smoke\.spec\.ts/,
	workers: 1,
	timeout: 180_000,
	reporter: 'list',
});
