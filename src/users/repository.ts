import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';

export type Role = 'owner' | 'admin' | 'member';
export type AvatarMode = 'bloop' | 'blobatar' | 'name';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  /** NULL for an account that only signs in through Crewly Cloud. */
  password_hash: string | null;
  role: Role;
  created_at: string;
  /** Set while access is withdrawn; null when they may use the server. */
  suspended_at: string | null;
  /** How they are drawn; the column defaults to 'bloop'. */
  avatar_mode?: AvatarMode;
}

export function createUser(
  db: Database,
  input: { email: string; displayName: string; passwordHash: string | null; role: Role }
): UserRow {
  const row: UserRow = {
    id: randomUUID(),
    email: input.email,
    display_name: input.displayName,
    password_hash: input.passwordHash,
    role: input.role,
    created_at: new Date().toISOString(),
    suspended_at: null,
  };
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, created_at, suspended_at)
     VALUES (@id, @email, @display_name, @password_hash, @role, @created_at, @suspended_at)`
  ).run(row);
  return row;
}

export function getUserByEmail(db: Database, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email) as UserRow | undefined;
}

export function getUserById(db: Database, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function countUsers(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  return row.count;
}

export function countOwners(db: Database): number {
  return (db.prepare(
    "SELECT COUNT(*) as count FROM users WHERE role = 'owner' AND suspended_at IS NULL",
  ).get() as { count: number }).count;
}

export function setUserRole(db: Database, id: string, role: Role): UserRow | undefined {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return getUserById(db, id);
}

/**
 * Takes access away, or gives it back.
 *
 * Suspending also drops their sessions: access that ends whenever a token
 * happens to expire is not access that was taken away.
 */
export function setUserSuspended(db: Database, id: string, suspended: boolean): UserRow | undefined {
  const suspendedAt = suspended ? new Date().toISOString() : null;
  db.transaction(() => {
    db.prepare('UPDATE users SET suspended_at = ? WHERE id = ?').run(suspendedAt, id);
    if (suspended) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  })();
  return getUserById(db, id);
}

export function deleteUser(db: Database, id: string): boolean {
  return db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  })();
}

/** What a person may change about themselves. */
export function updateOwnProfile(
  db: Database,
  id: string,
  input: { displayName?: string; avatarMode?: AvatarMode },
): UserRow | undefined {
  db.prepare(`UPDATE users SET display_name = COALESCE(?, display_name),
    avatar_mode = COALESCE(?, avatar_mode) WHERE id = ?`)
    .run(input.displayName ?? null, input.avatarMode ?? null, id);
  return getUserById(db, id);
}

/** Changes a person's sign-in email. The caller has checked who is asking and that the address is free. */
export function setUserEmail(db: Database, id: string, email: string): UserRow | undefined {
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, id);
  return getUserById(db, id);
}

export function setUserPassword(db: Database, id: string, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

/** True when this person also signs in through Crewly, whose account then owns their email. */
export function signsInWithCrewly(db: Database, id: string): boolean {
  return db.prepare("SELECT 1 FROM external_identities WHERE user_id = ? AND provider = 'crewly-cloud'").get(id) !== undefined;
}

export function listUsers(db: Database): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}
