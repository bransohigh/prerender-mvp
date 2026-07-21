import { defineConfig } from 'drizzle-kit';

// DATABASE_URL is read directly here (not via src/config/env.ts) because
// drizzle-kit is a dev-only CLI tool, not part of the running application —
// it must not trigger the app's full env validation (API keys etc.) just
// to generate/run migrations.
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run drizzle-kit commands');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
