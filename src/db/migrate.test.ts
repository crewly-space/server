import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './connection.js';
import { createSession, verifySessionToken } from '../auth/session.js';
import { EMBEDDED_MIGRATIONS } from './migrations.generated.js';
import { runMigrations } from './migrate.js';

describe('runMigrations', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('applies pending migrations once and is idempotent on re-run', () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-migrate-'));
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

  it('upgrades a server whose users already have sessions and devices', () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-migrate-'));
    const db = openDatabase(dataDir);
    // The server as it was before the users table was rebuilt (0017).
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const { name, sql } of EMBEDDED_MIGRATIONS) {
      if (name.startsWith('0017')) break;
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, 'then');
    }
    // Raw rows: today's repositories write columns this old schema lacks.
    db.prepare(
      "INSERT INTO users (id, email, display_name, password_hash, role, created_at) VALUES ('owner', 'owner@example.com', 'Owner', 'hash', 'owner', 'then')",
    ).run();
    const token = createSession(db, 'owner');
    db.prepare(
      "INSERT INTO devices (id, owner_user_id, name, public_key, created_at, updated_at) VALUES ('laptop', 'owner', 'Laptop', 'key', 'then', 'then')",
    ).run();

    expect(() => runMigrations(db)).not.toThrow();

    expect(verifySessionToken(db, token)).toBe('owner');
    expect(db.prepare("SELECT id FROM devices WHERE id = 'laptop'").get()).toBeDefined();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
