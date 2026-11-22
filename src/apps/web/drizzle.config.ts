import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config — SQL migration generation ONLY (no live push).
 * Migrations are applied by the hand-rolled, user_version-keyed runner in
 * src/lib/server/db/migrate.ts (forward only, backup first), not by
 * drizzle-kit's own migrator; drizzle-kit is used solely to emit the SQL from
 * the frozen schema into ./drizzle.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/server/db/schema.ts',
  out: './drizzle',
});
