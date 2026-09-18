import fs from 'node:fs';
import path from 'node:path';
import { openSqlite, type Database } from './driver.js';
import { loadOrCreateDatabaseSecretKey, registerDatabaseSecretKey } from './secrets.js';

export function openDatabase(dataDir: string): Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openSqlite(path.join(dataDir, 'opencrew.db'));
  registerDatabaseSecretKey(db, loadOrCreateDatabaseSecretKey(dataDir));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}
