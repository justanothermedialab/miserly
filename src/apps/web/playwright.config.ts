import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { E2E_DB_PATH } from './tests/e2e-env';

// M12 packaging + [[miserly-local-testing]] recipe:
//  - webServer is the REAL packaged entry `node build/index.js` (the adapter-node
//    artifact both deployment modes wrap), NOT `vite preview` — so every browser
//    spec now exercises the shipped server. ORIGIN is set (form POSTs 403 without
//    it — the #1 packaging bug); HOST/PORT bind loopback:4173.
//  - Drive INSTALLED Edge (`channel: 'msedge'`), not Playwright's bundled
//    Chrome-for-Testing (a RAM regression that OOMs the 8GB box). workers:1 +
//    low-RAM launch args keep peak memory to ~one Edge at a time.
const PORT = 4173;
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: 'tests',
	globalSetup: './tests/global-setup.ts',
	workers: 1,
	webServer: {
		command: 'pnpm build && node build/index.js',
		port: PORT,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000, // allow for the one-time vite build before serving
		env: {
			MISERLY_DB_PATH: E2E_DB_PATH,
			MISERLY_MIGRATIONS_DIR: fileURLToPath(new URL('./drizzle', import.meta.url)),
			HOST: '127.0.0.1',
			PORT: String(PORT),
			ORIGIN,
		},
	},
	use: {
		baseURL: ORIGIN,
		channel: 'msedge',
		headless: true,
		video: 'off',
		trace: 'off',
		launchOptions: {
			args: [
				'--disable-dev-shm-usage',
				'--disable-gpu',
				'--disable-extensions',
				'--disable-background-networking',
				'--js-flags=--max-old-space-size=512',
			],
		},
	},
});
