import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMBEDDED_MIGRATIONS, EMBEDDED_POSTGRES_MIGRATIONS } from './migrations.generated.js';

const DB_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The compiled `crewly-server` executable has no migrations directory to read,
 * so the SQL is embedded at build time. If someone adds a .sql file and forgets
 * to regenerate, the binary would quietly skip that migration — these tests turn
 * that into a build failure instead.
 */
describe.each([
  ['migrations', EMBEDDED_MIGRATIONS],
  ['migrations-postgres', EMBEDDED_POSTGRES_MIGRATIONS],
] as const)('embedded %s', (directory, embedded) => {
  const onDisk = fs
    .readdirSync(path.join(DB_DIR, directory))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  it('covers every migration file, in order', () => {
    expect(embedded.map((migration) => migration.name)).toEqual(onDisk);
  });

  it('matches each file byte for byte', () => {
    for (const { name, sql } of embedded) {
      expect(sql, `${name} is stale — run 'npm run build:migrations'`).toBe(
        fs.readFileSync(path.join(DB_DIR, directory, name), 'utf8').replace(/\r\n/g, '\n')
      );
    }
  });
});
