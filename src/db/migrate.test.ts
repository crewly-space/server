import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrate.js';

describe('runMigrations', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('applies pending migrations once and is idempotent on re-run', () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrew-migrate-'));
    const db = openDatabase(dataDir);

    const firstRun = runMigrations(db);
    expect(firstRun).toContain('0001_init.sql');

    const secondRun = runMigrations(db);
    expect(secondRun).toEqual([]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_log'")
      .all();
    expect(tables).toHaveLength(1);

    db.close();
  });
});
