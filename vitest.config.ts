import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup-env.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          setupFiles: ['./test/setup-env.ts'],
          include: ['test/**/*.test.ts'],
          exclude: ['test/integration/**', 'test/db/**'],
        },
      },
      {
        test: {
          name: 'integration',
          setupFiles: ['./test/setup-env.ts'],
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        test: {
          name: 'db',
          setupFiles: ['./test/setup-env.ts'],
          include: ['test/db/**/*.test.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
          // Test files share one real Postgres database and each truncates
          // all tables in beforeEach — running files in parallel causes one
          // file's truncate to wipe data another file is mid-test with.
          fileParallelism: false,
        },
      },
    ],
  },
});
