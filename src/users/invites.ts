import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import type { Role } from './repository.js';

/** How long an invite is worth anything. Long enough to be read, short enough to expire. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a dead invite stays on the list, so an admin can see what became of it. */
const INVITE_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

export type InviteRole = Extract<Role, 'admin' | 'member'>;
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface Invite {
  id: string;
  role: InviteRole;
  /** Who it is for, when the admin said; an accepting account must match. */
  email: string | null;
  status: InviteStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  revokedAt: string | null;
  label: string | null;
}

interface InviteRow {
  id: string;
  code_hash: string;
  role: InviteRole;
  email: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  revoked_at: string | null;
  label: string | null;
}

/** The code is a credential, so only its digest is ever stored. */
const digest = (code: string): string => createHash('sha256').update(code).digest('hex');

function statusOf(row: InviteRow, now: Date): InviteStatus {
  if (row.used_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

const toInvite = (row: InviteRow, now = new Date()): Invite => ({
  id: row.id,
  role: row.role,
  email: row.email,
  status: statusOf(row, now),
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  usedAt: row.used_at,
  usedBy: row.used_by,
  revokedAt: row.revoked_at,
  label: row.label,
});

export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

export function createInvite(
  db: Database,
  input: { role: InviteRole; createdBy: string; label?: string | null; email?: string | null },
): { invite: Invite; code: string } {
  const code = randomBytes(18).toString('base64url');
  const now = Date.now();
  const row: InviteRow = {
    id: randomUUID(),
    code_hash: digest(code),
    role: input.role,
    email: input.email ? normaliseEmail(input.email) : null,
    created_by: input.createdBy,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + INVITE_TTL_MS).toISOString(),
    used_at: null,
    used_by: null,
    revoked_at: null,
    label: input.label ?? null,
  };
  db.prepare(
    `INSERT INTO invites (id, code_hash, role, email, created_by, created_at, expires_at, used_at, used_by, revoked_at, label)
     VALUES (@id, @code_hash, @role, @email, @created_by, @created_at, @expires_at, @used_at, @used_by, @revoked_at, @label)`,
  ).run(row);
  return { invite: toInvite(row), code };
}

export function listInvites(db: Database): Invite[] {
  const rows = db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as InviteRow[];
  const now = new Date();
  return rows.map((row) => toInvite(row, now));
}

export function getInvite(db: Database, id: string): Invite | undefined {
  const row = db.prepare('SELECT * FROM invites WHERE id = ?').get(id) as InviteRow | undefined;
  return row ? toInvite(row) : undefined;
}

/** A still-pending invite for this address, if one was already sent. */
export function findPendingInviteFor(db: Database, email: string, now = new Date()): Invite | undefined {
  const rows = db
    .prepare('SELECT * FROM invites WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL')
    .all(normaliseEmail(email)) as InviteRow[];
  return rows.map((row) => toInvite(row, now)).find((invite) => invite.status === 'pending');
}

/** Withdraws a pending invite. It stays listed, as revoked. False when there was nothing to withdraw. */
export function revokeInvite(db: Database, id: string, now = new Date()): boolean {
  return db
    .prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL')
    .run(now.toISOString(), id).changes > 0;
}

/**
 * A new code and a fresh week for an invite that has not been used. The old
 * code stops working: it may be the reason for resending.
 */
export function renewInvite(db: Database, id: string, now = new Date()): { invite: Invite; code: string } | undefined {
  const code = randomBytes(18).toString('base64url');
  const changed = db
    .prepare('UPDATE invites SET code_hash = ?, expires_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL')
    .run(digest(code), new Date(now.getTime() + INVITE_TTL_MS).toISOString(), id).changes;
  if (!changed) return undefined;
  return { invite: getInvite(db, id)!, code };
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
  if (!row) return undefined;
  const invite = toInvite(row, now);
  return invite.status === 'pending' ? invite : undefined;
}

/** Marks an invite as spent. False when somebody else got there first. */
export function consumeInvite(db: Database, id: string, userId: string, now = new Date()): boolean {
  return (
    db
      .prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL')
      .run(now.toISOString(), userId, id).changes > 0
  );
}

/** Forgets invites that stopped mattering a while ago; recent ones stay to show how they ended. */
export function pruneExpiredInvites(db: Database, now = new Date()): void {
  const cutoff = new Date(now.getTime() - INVITE_HISTORY_MS).toISOString();
  db.prepare(
    `DELETE FROM invites WHERE used_at IS NULL AND (expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?))`,
  ).run(cutoff, cutoff);
}
