import fs from 'node:fs';
import path from 'node:path';
import { openSqlite, type Database } from './driver.js';
import { openPostgres } from './postgres.js';
import { registerDatabaseSecretKey, resolveDatabaseSecretKey } from './secrets.js';

/**
 * SQLite in `<dataDir>/crewly.db` unless a PostgreSQL URL is given. The data
 * directory is needed either way: it holds attachments and the secrets key.
 */
export function openDatabase(
  dataDir: string,
  options: { managedSecretsKey?: string; databaseUrl?: string } = {},
): Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const secretsKey = resolveDatabaseSecretKey(dataDir, options.managedSecretsKey);
  if (options.databaseUrl) {
    const db = openPostgres(options.databaseUrl);
    registerDatabaseSecretKey(db, secretsKey);
    return db;
  }
  const db = openSqlite(path.join(dataDir, 'crewly.db'));
  registerDatabaseSecretKey(db, secretsKey);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}
