import type { Database } from '../db/driver.js';
import { createHash, randomBytes } from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Token hashing shipped at this instant. Only sessions created before it can
// legitimately contain a plaintext token; their normal 30-day expiry bounds
// this compatibility path without forcing an immediate logout on upgrade.
const PLAINTEXT_SESSION_CUTOFF = '2026-09-17T12:55:49.000Z';
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
  let row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(digest) as
    | { user_id: string; expires_at: string }
    | undefined;
  // Preserve only sessions that can have been created by a pre-hardening
  // release, and upgrade them on first use. New rows never take this path.
  if (!row) {
    row = db.prepare(
      'SELECT user_id, expires_at FROM sessions WHERE token = ? AND created_at < ?'
    ).get(token, PLAINTEXT_SESSION_CUTOFF) as
      | { user_id: string; expires_at: string }
      | undefined;
    if (row) db.prepare('UPDATE sessions SET token = ? WHERE token = ?').run(digest, token);
  }
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(digest);
    return undefined;
  }
  return row.user_id;
}

export function revokeSession(db: Database, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token IN (?, ?)').run(digestToken(token), token);
}
