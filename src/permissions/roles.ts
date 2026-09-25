import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { getUserById, type Role } from '../users/repository.js';

export type PermissionId =
  | 'members.view'
  | 'members.manage'
  | 'members.invite'
  | 'agents.create'
  | 'agents.manage'
  | 'providers.manage'
  | 'integrations.manage'
  | 'automations.manage'
  | 'server.settings'
  | 'operations.view'
  | 'roles.manage';

export interface PermissionDefinition {
  id: PermissionId;
  label: string;
  description: string;
  group: 'People' | 'Workspace' | 'Services' | 'Server';
}

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { id: 'members.view', label: 'View members', description: 'See member names, emails and roles.', group: 'People' },
  { id: 'members.manage', label: 'Manage members', description: 'Change member access, roles and suspension.', group: 'People' },
  { id: 'members.invite', label: 'Invite members', description: 'Create and revoke invitations.', group: 'People' },
  { id: 'agents.create', label: 'Create agents', description: 'Add agents to this server.', group: 'Workspace' },
  { id: 'agents.manage', label: 'Manage agents', description: 'Change agents and their workspace settings.', group: 'Workspace' },
  { id: 'providers.manage', label: 'Manage providers', description: 'Configure model providers and credentials.', group: 'Services' },
  { id: 'integrations.manage', label: 'Manage integrations', description: 'Connect external services and tools.', group: 'Services' },
  { id: 'automations.manage', label: 'Manage automations', description: 'Create rules that react to events and run actions.', group: 'Workspace' },
  { id: 'server.settings', label: 'Manage server settings', description: 'Change server identity and configuration.', group: 'Server' },
  { id: 'operations.view', label: 'View operations', description: 'Read health, usage, runs and operational logs.', group: 'Server' },
  { id: 'roles.manage', label: 'Manage roles', description: 'Create roles and assign permissions.', group: 'People' },
];

const PERMISSIONS = new Set<PermissionId>(PERMISSION_DEFINITIONS.map((permission) => permission.id));
const ROLE_IDS: Record<Role, string> = { owner: 'builtin-owner', admin: 'builtin-admin', member: 'builtin-member' };
const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export class RoleValidationError extends Error {}
export class RoleForbiddenError extends Error {}

export interface ServerRole {
  id: string;
  name: string;
  description: string;
  permissions: PermissionId[];
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RoleRow {
  id: string;
  name: string;
  description: string;
  permissions: string;
  built_in: number;
  created_at: string;
  updated_at: string;
}

function parsePermissions(encoded: string): PermissionId[] {
  let parsed: unknown;
  try { parsed = JSON.parse(encoded); } catch { parsed = []; }
  return Array.isArray(parsed) ? parsed.filter((item): item is PermissionId => typeof item === 'string' && PERMISSIONS.has(item as PermissionId)) : [];
}

function view(row: RoleRow): ServerRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: parsePermissions(row.permissions),
    builtIn: Boolean(row.built_in),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listRoles(db: Database): ServerRole[] {
  return (db.prepare('SELECT * FROM server_roles ORDER BY built_in DESC, name COLLATE NOCASE').all() as RoleRow[]).map(view);
}

export function getRole(db: Database, id: string): ServerRole | undefined {
  const row = db.prepare('SELECT * FROM server_roles WHERE id = ?').get(id) as RoleRow | undefined;
  return row ? view(row) : undefined;
}

export function listRolesForUser(db: Database, userId: string): ServerRole[] {
  return (db.prepare(
    `SELECT r.* FROM server_roles r JOIN user_server_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = ? ORDER BY r.name COLLATE NOCASE`,
  ).all(userId) as RoleRow[]).map(view);
}

export function effectivePermissions(db: Database, userId: string): Set<PermissionId> {
  const user = getUserById(db, userId);
  if (!user) return new Set();
  const roles = [getRole(db, ROLE_IDS[user.role]), ...listRolesForUser(db, userId)].filter((role): role is ServerRole => Boolean(role));
  return new Set(roles.flatMap((role) => role.permissions));
}

export function hasPermission(db: Database, userId: string, permission: PermissionId): boolean {
  return effectivePermissions(db, userId).has(permission);
}

function normalizePermissions(input: string[]): PermissionId[] {
  const unique = [...new Set(input)];
  if (unique.some((permission) => !PERMISSIONS.has(permission as PermissionId))) throw new RoleValidationError('unknown permission');
  return unique as PermissionId[];
}

export function assertCanManageRole(db: Database, actorId: string, permissions: string[]): PermissionId[] {
  if (!hasPermission(db, actorId, 'roles.manage')) throw new RoleForbiddenError('roles_manage_required');
  const normalized = normalizePermissions(permissions);
  const available = effectivePermissions(db, actorId);
  if (normalized.some((permission) => !available.has(permission))) throw new RoleForbiddenError('cannot_grant_permission_above_your_authority');
  return normalized;
}

export function createRole(db: Database, input: { name: string; description?: string; permissions: string[]; createdBy: string }): ServerRole {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new RoleValidationError('role name must be between 2 and 80 characters');
  const permissions = normalizePermissions(input.permissions);
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO server_roles (id, name, description, permissions, built_in, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(id, name, input.description?.trim() ?? '', JSON.stringify(permissions), input.createdBy, now, now);
  return getRole(db, id)!;
}

export function updateRole(db: Database, id: string, input: { name: string; description?: string; permissions: string[] }): ServerRole {
  const current = getRole(db, id);
  if (!current) throw new RoleValidationError('role_not_found');
  if (current.builtIn) throw new RoleForbiddenError('built_in_roles_are_fixed');
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new RoleValidationError('role name must be between 2 and 80 characters');
  const permissions = normalizePermissions(input.permissions);
  db.prepare('UPDATE server_roles SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE id = ?')
    .run(name, input.description?.trim() ?? '', JSON.stringify(permissions), new Date().toISOString(), id);
  return getRole(db, id)!;
}

export function deleteRole(db: Database, id: string): boolean {
  const role = getRole(db, id);
  if (!role) return false;
  if (role.builtIn) throw new RoleForbiddenError('built_in_roles_are_fixed');
  if (db.prepare('SELECT 1 FROM user_server_roles WHERE role_id = ? LIMIT 1').get(id)) throw new RoleForbiddenError('role_is_assigned');
  return db.prepare('DELETE FROM server_roles WHERE id = ?').run(id).changes > 0;
}

export function assignRole(db: Database, roleId: string, userId: string, assignedBy: string): void {
  const role = getRole(db, roleId);
  const target = getUserById(db, userId);
  const actor = getUserById(db, assignedBy);
  if (!role || role.builtIn) throw new RoleValidationError('custom_role_required');
  if (!target || !actor) throw new RoleValidationError('user_not_found');
  if (ROLE_RANK[target.role] > ROLE_RANK[actor.role]) throw new RoleForbiddenError('cannot_change_a_higher_role');
  assertCanManageRole(db, assignedBy, role.permissions);
  db.prepare('INSERT OR IGNORE INTO user_server_roles (user_id, role_id, assigned_by, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, roleId, assignedBy, new Date().toISOString());
}

export function unassignRole(db: Database, roleId: string, userId: string, assignedBy: string): boolean {
  if (!hasPermission(db, assignedBy, 'roles.manage')) throw new RoleForbiddenError('roles_manage_required');
  const target = getUserById(db, userId);
  const actor = getUserById(db, assignedBy);
  if (!target || !actor) throw new RoleValidationError('user_not_found');
  if (ROLE_RANK[target.role] > ROLE_RANK[actor.role]) throw new RoleForbiddenError('cannot_change_a_higher_role');
  return db.prepare('DELETE FROM user_server_roles WHERE user_id = ? AND role_id = ?').run(userId, roleId).changes > 0;
}
