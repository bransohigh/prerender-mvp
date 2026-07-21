// Runs before any test file imports src/config/env.ts. Provides safe
// placeholder values for required env vars so unit tests never need a
// reachable PostgreSQL instance (pg.Pool connects lazily). Database
// integration tests (test/db/*.test.ts) override DATABASE_URL via their
// own CI-provided value.
process.env['DATABASE_URL'] ??= 'postgres://postgres:postgres@localhost:5432/prerender_test';
process.env['BETTER_AUTH_SECRET'] ??= 'test-better-auth-secret-minimum-32-characters-long';
process.env['BETTER_AUTH_BASE_URL'] ??= 'http://localhost:3000';
process.env['AUTH_TRUSTED_ORIGINS'] ??= 'http://localhost:3000';
