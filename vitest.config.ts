import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 10000,
    // CREWLY_TEST_DATABASE_URL runs the suite against PostgreSQL instead of SQLite.
    setupFiles: process.env.CREWLY_TEST_DATABASE_URL ? ['test/support/postgres.ts'] : [],
  },
});
