import { AgentSchema, type Agent, type AvatarMode, type ModelPolicy, type PermissionSet } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';

interface AgentRow {
  id: string;
  owner_user_id: string;
  name: string;
  personality: string;
  model_policy: string;
  permissions: string;
  availability?: 'auto' | 'dnd';
  avatar_mode?: AvatarMode;
  created_at: string;
  updated_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  return AgentSchema.parse({
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    personality: row.personality,
    modelPolicy: JSON.parse(row.model_policy),
    permissions: JSON.parse(row.permissions),
    relationships: [],
    availability: row.availability ?? 'auto',
    avatarMode: row.avatar_mode ?? 'bloop',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createAgent(
  db: Database,
  input: {
    ownerUserId: string;
    name: string;
    personality: string;
    modelPolicy: ModelPolicy;
    permissions: PermissionSet;
    avatarMode?: AvatarMode;
  }
): Agent {
  const now = new Date().toISOString();
  const row: AgentRow = {
    id: randomUUID(),
    owner_user_id: input.ownerUserId,
    name: input.name,
    personality: input.personality,
    model_policy: JSON.stringify(input.modelPolicy),
    permissions: JSON.stringify(input.permissions),
    avatar_mode: input.avatarMode ?? 'bloop',
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO agents (id, owner_user_id, name, personality, model_policy, permissions, avatar_mode, created_at, updated_at)
     VALUES (@id, @owner_user_id, @name, @personality, @model_policy, @permissions, @avatar_mode, @created_at, @updated_at)`
  ).run(row);
  return rowToAgent(row);
}

export function getAgent(db: Database, id: string): Agent | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : undefined;
}

export function listAgentsForOwner(db: Database, ownerUserId: string): Agent[] {
  const rows = db.prepare('SELECT * FROM agents WHERE owner_user_id = ?').all(ownerUserId) as AgentRow[];
  return rows.map(rowToAgent);
}

export function updateAgent(db: Database, id: string, ownerUserId: string, input: {
  name: string; personality: string; modelPolicy: ModelPolicy; avatarMode?: AvatarMode;
}): Agent | undefined {
  // An update that does not mention the avatar keeps the one it had.
  const info = db.prepare(`UPDATE agents SET name = ?, personality = ?, model_policy = ?,
    avatar_mode = COALESCE(?, avatar_mode), updated_at = ?
    WHERE id = ? AND owner_user_id = ?`).run(input.name, input.personality,
    JSON.stringify(input.modelPolicy), input.avatarMode ?? null, new Date().toISOString(), id, ownerUserId);
  return info.changes ? getAgent(db, id) : undefined;
}

export function setAgentAvailability(db: Database, id: string, availability: 'auto' | 'dnd'): Agent | undefined {
  const info = db.prepare('UPDATE agents SET availability = ?, updated_at = ? WHERE id = ?')
    .run(availability, new Date().toISOString(), id);
  return info.changes ? getAgent(db, id) : undefined;
}

export function listAllAgents(db: Database): Agent[] {
  const rows = db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as AgentRow[];
  return rows.map(rowToAgent);
}
