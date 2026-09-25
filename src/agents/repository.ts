import { AgentSchema, type Agent, type AgentRoutingMode, type AvatarMode, type ModelPolicy, type PermissionSet } from '../protocol/index.js';
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
  routing_mode?: AgentRoutingMode;
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
    routingMode: row.routing_mode ?? 'mention_only',
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
    routing_mode: 'mention_only',
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO agents (id, owner_user_id, name, personality, model_policy, permissions, avatar_mode, routing_mode, created_at, updated_at)
     VALUES (@id, @owner_user_id, @name, @personality, @model_policy, @permissions, @avatar_mode, @routing_mode, @created_at, @updated_at)`
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

export interface AgentRoutingOverride {
  conversationId: string;
  conversationName: string;
  mode: AgentRoutingMode;
}

export interface AgentRoutingConfig {
  defaultMode: AgentRoutingMode;
  overrides: AgentRoutingOverride[];
}

export function getAgentRouting(db: Database, agentId: string): AgentRoutingConfig | undefined {
  const agent = getAgent(db, agentId);
  if (!agent) return undefined;
  const rows = db.prepare(`
    SELECT r.conversation_id, c.name, r.mode
    FROM agent_conversation_routing r
    JOIN conversations c ON c.id = r.conversation_id
    WHERE r.agent_id = ?
    ORDER BY c.name COLLATE NOCASE
  `).all(agentId) as Array<{ conversation_id: string; name: string | null; mode: AgentRoutingMode }>;
  return {
    defaultMode: agent.routingMode,
    overrides: rows.map((row) => ({
      conversationId: row.conversation_id,
      conversationName: row.name ?? row.conversation_id,
      mode: row.mode,
    })),
  };
}

export function effectiveAgentRoutingMode(db: Database, agentId: string, conversationId: string): AgentRoutingMode | undefined {
  const row = db.prepare(`
    SELECT COALESCE(
      (SELECT mode FROM agent_conversation_routing WHERE agent_id = ? AND conversation_id = ?),
      (SELECT routing_mode FROM agents WHERE id = ?)
    ) AS mode
  `).get(agentId, conversationId, agentId) as { mode?: AgentRoutingMode } | undefined;
  return row?.mode;
}

export function setAgentRoutingMode(
  db: Database,
  agentId: string,
  mode: AgentRoutingMode,
  conversationId: string | null,
  updatedBy: string,
): AgentRoutingConfig | undefined {
  const now = new Date().toISOString();
  if (conversationId === null) {
    db.prepare('UPDATE agents SET routing_mode = ?, updated_at = ? WHERE id = ?').run(mode, now, agentId);
  } else {
    db.prepare(`
      INSERT INTO agent_conversation_routing (agent_id, conversation_id, mode, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent_id, conversation_id) DO UPDATE SET mode = excluded.mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(agentId, conversationId, mode, updatedBy, now, now);
  }
  return getAgentRouting(db, agentId);
}

export function clearAgentRoutingOverride(db: Database, agentId: string, conversationId: string): AgentRoutingConfig | undefined {
  db.prepare('DELETE FROM agent_conversation_routing WHERE agent_id = ? AND conversation_id = ?').run(agentId, conversationId);
  return getAgentRouting(db, agentId);
}
