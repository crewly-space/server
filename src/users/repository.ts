import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';

export type Role = 'owner' | 'admin' | 'member';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  /** NULL for an account that only signs in through Crewly Cloud. */
  password_hash: string | null;
  role: Role;
  created_at: string;
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
  };
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, created_at)
     VALUES (@id, @email, @display_name, @password_hash, @role, @created_at)`
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

export function listUsers(db: Database): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}
