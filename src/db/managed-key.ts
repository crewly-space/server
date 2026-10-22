import { createHash } from 'node:crypto';
import type { Database } from './driver.js';

/** The remote primary must refuse a new deployment's unrelated encryption key. */
export function verifyManagedDatabaseKey(db: Database, key: Buffer): void {
  const fingerprint = createHash('sha256').update(key).digest('hex');
  db.exec('CREATE TABLE IF NOT EXISTS crewly_storage_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare("INSERT OR IGNORE INTO crewly_storage_metadata (name, value) VALUES ('secrets_key_sha256', ?)").run(fingerprint);
  const existing = db.prepare("SELECT value FROM crewly_storage_metadata WHERE name = 'secrets_key_sha256'").pluck().get();
  if (existing !== fingerprint) throw new Error('CREWLY_SECRETS_KEY does not match this Turso database. Restore the original key from your hosting dashboard.');
}
