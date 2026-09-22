import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import type { Role } from './repository.js';

/** How long an invite is worth anything. Long enough to be read, short enough to expire. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteRole = Extract<Role, 'admin' | 'member'>;

export interface Invite {
  id: string;
  role: InviteRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  label: string | null;
}

interface InviteRow {
  id: string;
  code_hash: string;
  role: InviteRole;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  label: string | null;
}

/** The code is a credential, so only its digest is ever stored. */
const digest = (code: string): string => createHash('sha256').update(code).digest('hex');

const toInvite = (row: InviteRow): Invite => ({
  id: row.id,
  role: row.role,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  usedAt: row.used_at,
  usedBy: row.used_by,
  label: row.label,
});

export function createInvite(
  db: Database,
  input: { role: InviteRole; createdBy: string; label?: string | null },
): { invite: Invite; code: string } {
  const code = randomBytes(18).toString('base64url');
  const now = Date.now();
  const row: InviteRow = {
    id: randomUUID(),
    code_hash: digest(code),
    role: input.role,
    created_by: input.createdBy,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + INVITE_TTL_MS).toISOString(),
    used_at: null,
    used_by: null,
    label: input.label ?? null,
  };
  db.prepare(
    `INSERT INTO invites (id, code_hash, role, created_by, created_at, expires_at, used_at, used_by, label)
     VALUES (@id, @code_hash, @role, @created_by, @created_at, @expires_at, @used_at, @used_by, @label)`,
  ).run(row);
  return { invite: toInvite(row), code };
}

export function listInvites(db: Database): Invite[] {
  const rows = db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as InviteRow[];
  return rows.map(toInvite);
}

export function revokeInvite(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM invites WHERE id = ?').run(id).changes > 0;
}

/**
 * The invite a code stands for, if it is still worth anything.
 *
 * Used, revoked and expired all answer the same way, because none of them is
 * something the person holding the code can do anything about, and telling
 * them apart would say more about this server than a stranger needs to know.
 */
export function findUsableInvite(db: Database, code: string, now = new Date()): Invite | undefined {
  const row = db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(digest(code)) as InviteRow | undefined;
  if (!row || row.used_at) return undefined;
  if (new Date(row.expires_at).getTime() <= now.getTime()) return undefined;
  return toInvite(row);
}

/** Marks an invite as spent. False when somebody else got there first. */
export function consumeInvite(db: Database, id: string, userId: string, now = new Date()): boolean {
  return (
    db
      .prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL')
      .run(now.toISOString(), userId, id).changes > 0
  );
}

export function pruneExpiredInvites(db: Database, now = new Date()): void {
  db.prepare('DELETE FROM invites WHERE used_at IS NULL AND expires_at <= ?').run(now.toISOString());
}
