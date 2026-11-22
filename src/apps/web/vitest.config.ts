import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const $lib = fileURLToPath(new URL('./src/lib', import.meta.url));

/**
 * Two vitest projects:
 * - `server`: node-environment suites (M3 persistence + M4 auth/visibility). Runs under plain
 *   node, NOT the SvelteKit Vite plugin, so `$app/*` and load-time SvelteKit magic are
 *   unavailable; the modules under test import none of it. The ONE alias is `$lib`, so the M4
 *   route-boundary test can import the real `+page.server.ts` `load` functions.
 * - `ssr`: components rendered as the server renders them (test/ssr; stubs for $app/*).
 * - `components`: Svelte component behaviour under jsdom (`test/components/*.test.ts`), compiled
 *   with the plain Svelte plugin and the browser export condition.
 * Playwright e2e stays separate (`pnpm test:e2e`).
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { $lib } },
        test: {
          name: 'server',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/components/**', 'test/ssr/**'],
        },
      },
      {
        // `ssr`: components rendered the way the server renders a page's first frame (svelte/server),
        // so a browser-only read during render fails here instead of as a 500 in the app.
        plugins: [svelte({ compilerOptions: { runes: true } })],
        resolve: {
          alias: {
            $lib,
            '$app/state': fileURLToPath(new URL('./test/ssr/stubs/app-state.ts', import.meta.url)),
            '$app/navigation': fileURLToPath(new URL('./test/ssr/stubs/app-navigation.ts', import.meta.url)),
            '$app/forms': fileURLToPath(new URL('./test/ssr/stubs/app-forms.ts', import.meta.url)),
          },
        },
        test: {
          name: 'ssr',
          environment: 'node',
          include: ['test/ssr/**/*.test.ts'],
        },
      },
      {
        plugins: [svelte({ compilerOptions: { runes: true } })],
        resolve: { alias: { $lib }, conditions: ['browser'] },
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['test/components/**/*.test.ts'],
          setupFiles: ['test/components/setup.ts'],
        },
      },
    ],
  },
});
