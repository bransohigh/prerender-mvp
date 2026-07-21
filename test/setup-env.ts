// Runs before any test file imports src/config/env.ts. Provides safe
// placeholder values for required env vars so unit tests never need a
// reachable PostgreSQL instance (pg.Pool connects lazily). Database
// integration tests (test/db/*.test.ts) override DATABASE_URL via their
// own CI-provided value.
process.env['DATABASE_URL'] ??= 'postgres://postgres:postgres@localhost:5432/prerender_test';
process.env['ADMIN_API_KEY'] ??= 'test-admin-api-key-minimum-32-characters';
process.env['RENDER_API_KEY'] ??= 'test-render-api-key-minimum-32-characters';
