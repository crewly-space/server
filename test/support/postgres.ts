import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';

/*
 * Loaded only with CREWLY_TEST_DATABASE_URL set (see vitest.config.ts). Every in-memory database a test opens is
 * a fresh schema on that PostgreSQL server instead, so the whole suite runs
 * against the PostgreSQL driver unchanged. File-backed databases stay SQLite:
 * the tests that use them are about SQLite itself.
 */
const server = process.env.CREWLY_TEST_DATABASE_URL!.trim();

vi.mock(import('../../src/db/driver.js'), async (importOriginal) => {
  const original = await importOriginal();
  const { openPostgres } = await import('../../src/db/postgres.js');
  return {
    ...original,
    openSqlite: (file: string) => {
      if (file !== ':memory:') return original.openSqlite(file);
      const url = new URL(server);
      url.searchParams.set('options', `-c search_path=server_test_${randomUUID().replaceAll('-', '')}`);
      return openPostgres(url.toString());
    },
  };
});
