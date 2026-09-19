import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMBEDDED_MIGRATIONS } from './migrations.generated.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * The compiled `crewly-server` executable has no migrations directory to read,
 * so the SQL is embedded at build time. If someone adds a .sql file and forgets
 * to regenerate, the binary would quietly skip that migration — these tests turn
 * that into a build failure instead.
 */
describe('embedded migrations', () => {
  const onDisk = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  it('covers every migration file, in order', () => {
    expect(EMBEDDED_MIGRATIONS.map((migration) => migration.name)).toEqual(onDisk);
  });

  it('matches each file byte for byte', () => {
    for (const { name, sql } of EMBEDDED_MIGRATIONS) {
      expect(sql, `${name} is stale — run 'npm run build:migrations'`).toBe(
        fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8').replace(/\r\n/g, '\n')
      );
    }
  });
});
