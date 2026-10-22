import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqlite } from './driver.js';
import { exportDatabase } from './export.js';
import { runMigrations } from './migrate.js';
import { registerDatabaseSecretKey } from './secrets.js';
import { createUser } from '../users/repository.js';
import { createProviderConfig, getProviderConfig } from '../providers/repository.js';
import { verifyManagedDatabaseKey } from './managed-key.js';

let directory: string;
afterEach(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
it('exports rows and encrypted credentials to a new SQLite file without touching the source', () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-export-'));
  const key = Buffer.alloc(32, 7);
  const source = openSqlite(':memory:');
  registerDatabaseSecretKey(source, key);
  runMigrations(source);
  const user = createUser(source, { email: 'one@example.test', displayName: 'One', passwordHash: 'hash', role: 'owner' });
  createProviderConfig(source, { id: 'provider', kind: 'anthropic', apiKey: 'test-secret' });
  const filename = path.join(directory, 'export.db');
  try {
    const counts = exportDatabase(source, filename, key);
    expect(counts.users).toBe(1);
    expect(source.prepare('SELECT id FROM users').pluck().get()).toBe(user.id);
    const target = openSqlite(filename);
    registerDatabaseSecretKey(target, key);
    try {
      expect(target.prepare('SELECT id FROM users').pluck().get()).toBe(user.id);
      expect(getProviderConfig(target, 'provider')?.apiKey).toBe('test-secret');
      expect(() => verifyManagedDatabaseKey(target, Buffer.alloc(32, 8))).toThrow(/original key/);
      expect(target.pragma('foreign_key_check')).toEqual([]);
    } finally { target.close(); }
    expect(() => exportDatabase(source, filename, key)).toThrow();
    expect(fs.statSync(filename).size).toBeGreaterThan(0);
  } finally { source.close(); }
});
