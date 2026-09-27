import type { Database } from '../db/driver.js';
import { createHash, randomBytes } from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const digestToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createSession(db: Database, userId: string): string {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    digestToken(token),
    userId,
    new Date(now).toISOString(),
    new Date(now + SESSION_TTL_MS).toISOString()
  );
  return token;
}

export function verifySessionToken(db: Database, token: string): string | undefined {
  const digest = digestToken(token);
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(digest) as
    | { user_id: string; expires_at: string }
    | undefined;
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(digest);
    return undefined;
  }
  return row.user_id;
}

export function revokeSession(db: Database, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(digestToken(token));
}
