import { RuntimeSessionSchema, type RuntimeSession, type RuntimeSessionStatus } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';

interface RuntimeSessionRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  runtime_binding_id: string;
  status: RuntimeSessionStatus;
  created_at: string;
  updated_at: string;
}

function rowToRuntimeSession(row: RuntimeSessionRow): RuntimeSession {
  return RuntimeSessionSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    runtimeBindingId: row.runtime_binding_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createRuntimeSession(
  db: Database,
  input: { agentId: string; conversationId: string; runtimeBindingId: string; status?: RuntimeSessionStatus }
): RuntimeSession {
  const now = new Date().toISOString();
  const row: RuntimeSessionRow = {
    id: randomUUID(),
    agent_id: input.agentId,
    conversation_id: input.conversationId,
    runtime_binding_id: input.runtimeBindingId,
    status: input.status ?? 'idle',
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO runtime_sessions (id, agent_id, conversation_id, runtime_binding_id, status, created_at, updated_at)
     VALUES (@id, @agent_id, @conversation_id, @runtime_binding_id, @status, @created_at, @updated_at)`
  ).run(row);
  return rowToRuntimeSession(row);
}

export function getRuntimeSession(db: Database, id: string): RuntimeSession | undefined {
  const row = db.prepare('SELECT * FROM runtime_sessions WHERE id = ?').get(id) as RuntimeSessionRow | undefined;
  return row ? rowToRuntimeSession(row) : undefined;
}

export function updateRuntimeSessionStatus(
  db: Database,
  id: string,
  status: RuntimeSessionStatus
): RuntimeSession | undefined {
  db.prepare('UPDATE runtime_sessions SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    id
  );
  return getRuntimeSession(db, id);
}
