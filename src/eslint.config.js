// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import betterTailwind from 'eslint-plugin-better-tailwindcss';
import svelteParser from 'svelte-eslint-parser';

// The JS/TS rule sets apply to JS/TS files only; .svelte files are parsed for one job, the
// Tailwind class rules below.
const CODE = ['**/*.{js,mjs,cjs,ts}'];

export default tseslint.config(
  {
    ignores: ['**/node_modules', '**/.svelte-kit', '**/build', '**/dist'],
  },
  { ...js.configs.recommended, files: CODE },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: CODE })),
  {
    // .svelte files are parsed (TypeScript inside <script lang="ts">) for the Tailwind rules only.
    files: ['apps/web/src/**/*.svelte'],
    languageOptions: { parser: svelteParser, parserOptions: { parser: tseslint.parser } },
  },
  {
    // Spacing and sizes come from the 4 px scale and the named tokens in app.css (C7,
    // session 3). An arbitrary px length (`mb-[14px]`, `w-[150px]`, `max-[1099px]:`) is an error:
    // use the scale (`mb-4`, `w-38`), a token (`gap-control`, `p-surface`) or the `narrow:` variant.
    files: ['apps/web/src/**/*.svelte', 'apps/web/src/**/*.ts'],
    plugins: { 'better-tailwindcss': betterTailwind },
    settings: { 'better-tailwindcss': { entryPoint: 'apps/web/src/app.css' } },
    rules: {
      'better-tailwindcss/no-restricted-classes': [
        'error',
        {
          restrict: [
            {
              pattern: String.raw`^.*\[-?[0-9.]+px\].*$`,
              message:
                'Arbitrary px value: use the 4 px scale (e.g. mb-4, w-38), a spacing token (gap-control, gap-content, p-surface, mt-section) or the narrow: variant.',
            },
          ],
        },
      ],
    },
  },
  {
    // Plain Node ESM scripts (e.g. tests/collect-videos.mjs) — give them the Node
    // runtime globals so `no-undef` (kept on for JS, unlike TS) doesn't fire.
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
  {
    // packages/core is the pure-TS domain engine. It MUST NOT import any
    // framework, UI, or DB-driver code, and MUST NOT import the web app.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['svelte', '@sveltejs/*'],
              message: 'packages/core is a pure-TS engine and must not import Svelte/SvelteKit.',
            },
            {
              group: ['better-sqlite3', 'drizzle-orm'],
              message: 'packages/core is a pure-TS engine and must not import a DB driver/ORM.',
            },
            {
              group: ['@miserly/web'],
              message: 'packages/core must not depend on apps/web (dependency direction is web -> core).',
            },
          ],
        },
      ],
    },
  },
  {
    // The aggregation layer reads ONLY the contract + the module registry — it
    // must NEVER import a concrete instrument module. This is the code-level
    // enforcement of "no `if module==='FD'`" (docs/product/architecture.md
    // §5). Concrete modules are wired into the
    // registry from modules/index.ts (outside aggregation/), never imported here.
    //
    // NOTE: flat-config replaces `no-restricted-imports` wholesale for files
    // matched by a later block, so this override must RE-STATE the core-purity
    // patterns above (svelte / DB / web) in addition to the modules ban —
    // otherwise aggregation files would silently lose the purity guard.
    files: ['packages/core/src/aggregation/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['svelte', '@sveltejs/*'],
              message: 'packages/core is a pure-TS engine and must not import Svelte/SvelteKit.',
            },
            {
              group: ['better-sqlite3', 'drizzle-orm'],
              message: 'packages/core is a pure-TS engine and must not import a DB driver/ORM.',
            },
            {
              group: ['@miserly/web'],
              message: 'packages/core must not depend on apps/web (dependency direction is web -> core).',
            },
            {
              group: ['**/modules/*', '**/modules'],
              message:
                'Aggregation must not import a concrete instrument module — read the module registry instead (contract guarantee: no `if module===`).',
            },
          ],
        },
      ],
    },
  },
);
