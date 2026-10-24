import fs from 'node:fs';
import path from 'node:path';
import { openSqlite, type Database } from './driver.js';
import { openTurso } from './turso.js';
import { openPostgres } from './postgres.js';
import { verifyManagedDatabaseKey } from './managed-key.js';
import { registerDatabaseSecretKey, resolveDatabaseSecretKey } from './secrets.js';

/**
 * SQLite locally, managed Turso, or legacy PostgreSQL.
 * The persistent data directory holds uploads, device identity and key metadata.
 */
export function openDatabase(
  dataDir: string,
  options: { managedSecretsKey?: string; databaseUrl?: string; turso?: { url: string; authToken: string } } = {},
): Database {
  if (options.databaseUrl && options.turso) throw new Error('Choose Turso or PostgreSQL, not both');
  fs.mkdirSync(dataDir, { recursive: true });
  if (options.turso) {
    if (!options.managedSecretsKey) throw new Error('Turso requires a stable CREWLY_SECRETS_KEY from your hosting dashboard');
    const key = Buffer.from(options.managedSecretsKey, 'base64');
    if (key.length !== 32) throw new Error('CREWLY_SECRETS_KEY must be 32 bytes, base64-encoded');
    const db = openTurso(options.turso.url, options.turso.authToken);
    try {
      verifyManagedDatabaseKey(db, key);
      const secretsKey = resolveDatabaseSecretKey(dataDir, options.managedSecretsKey);
      registerDatabaseSecretKey(db, secretsKey);
      db.pragma('foreign_keys = ON');
      return db;
    } catch (error) { db.close(); throw error; }
  }
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
