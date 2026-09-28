import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { redactArguments } from './schema.js';
import type { ConnectionKind, ToolPolicyMode, ToolRisk } from './types.js';

/**
 * Every external tool execution, and every refusal, in one place. Arguments
 * pass through redaction before they are written; results are kept only as
 * metadata (size, error flag), never their content.
 */

export type ToolExecutionStatus = 'success' | 'error' | 'blocked' | 'approval_required';

export interface ToolExecution {
  id: string;
  createdAt: string;
  agentId: string | null;
  userId: string | null;
  runId: string | null;
  conversationId: string | null;
  skillId: string | null;
  connectionKind: ConnectionKind;
  connectionId: string;
  provider: string | null;
  toolRef: string;
  toolName: string;
  risk: ToolRisk;
  permission: string | null;
  arguments: unknown;
  status: ToolExecutionStatus;
  policyMode: ToolPolicyMode | null;
  approvalId: string | null;
  resultMeta: Record<string, unknown>;
  durationMs: number;
  error: string | null;
}

export interface ToolExecutionInput extends Omit<ToolExecution, 'id' | 'createdAt' | 'arguments'> {
  arguments: unknown;
  /** Literal secret values resolved for this call; they are scrubbed from the record too. */
  knownSecrets?: string[];
}

interface Row {
  id: string; created_at: string; agent_id: string | null; user_id: string | null; run_id: string | null; conversation_id: string | null;
  skill_id: string | null; connection_kind: ConnectionKind; connection_id: string; provider: string | null; tool_ref: string; tool_name: string;
  risk: ToolRisk; permission: string | null; arguments: string; status: ToolExecutionStatus; policy_mode: ToolPolicyMode | null;
  approval_id: string | null; result_meta: string; duration_ms: number; error: string | null;
}

const view = (row: Row): ToolExecution => ({
  id: row.id, createdAt: row.created_at, agentId: row.agent_id, userId: row.user_id, runId: row.run_id, conversationId: row.conversation_id,
  skillId: row.skill_id, connectionKind: row.connection_kind, connectionId: row.connection_id, provider: row.provider, toolRef: row.tool_ref,
  toolName: row.tool_name, risk: row.risk, permission: row.permission, arguments: JSON.parse(row.arguments), status: row.status,
  policyMode: row.policy_mode, approvalId: row.approval_id, resultMeta: JSON.parse(row.result_meta), durationMs: row.duration_ms, error: row.error,
});

export function recordToolExecution(db: Database, input: ToolExecutionInput): ToolExecution {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const redacted = redactArguments(input.arguments, input.knownSecrets);
  const error = input.error ? String(redactArguments(input.error, input.knownSecrets)).slice(0, 1000) : null;
  db.prepare(`INSERT INTO tool_executions (id, created_at, agent_id, user_id, run_id, conversation_id, skill_id, connection_kind, connection_id,
      provider, tool_ref, tool_name, risk, permission, arguments, status, policy_mode, approval_id, result_meta, duration_ms, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, createdAt, input.agentId, input.userId, input.runId, input.conversationId, input.skillId, input.connectionKind, input.connectionId,
    input.provider, input.toolRef, input.toolName, input.risk, input.permission, JSON.stringify(redacted ?? {}), input.status,
    input.policyMode, input.approvalId, JSON.stringify(input.resultMeta ?? {}), Math.max(0, Math.round(input.durationMs)), error,
  );
  return view(db.prepare('SELECT * FROM tool_executions WHERE id = ?').get(id) as Row);
}

export interface ToolExecutionFilter {
  agentId?: string;
  agentIds?: string[];
  connectionId?: string;
  runId?: string;
  status?: ToolExecutionStatus;
  toolRef?: string;
  before?: string;
  limit?: number;
}

export function listToolExecutions(db: Database, filter: ToolExecutionFilter = {}): ToolExecution[] {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { where.push(sql); params.push(value); };
  if (filter.agentId) add('agent_id = ?', filter.agentId);
  if (filter.connectionId) add('connection_id = ?', filter.connectionId);
  if (filter.runId) add('run_id = ?', filter.runId);
  if (filter.status) add('status = ?', filter.status);
  if (filter.toolRef) add('tool_ref = ?', filter.toolRef);
  if (filter.before) add('created_at < ?', filter.before);
  if (filter.agentIds) {
    if (!filter.agentIds.length) return [];
    where.push(`agent_id IN (${filter.agentIds.map(() => '?').join(', ')})`);
    params.push(...filter.agentIds);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const sql = `SELECT * FROM tool_executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return (db.prepare(sql).all(...params) as Row[]).map(view);
}

/** The last successful call per connection, for connection health. */
export function lastSuccessByConnection(db: Database): Map<string, string> {
  const rows = db.prepare(`SELECT connection_id, MAX(created_at) AS last_at FROM tool_executions WHERE status = 'success' GROUP BY connection_id`)
    .all() as Array<{ connection_id: string; last_at: string }>;
  return new Map(rows.map((row) => [row.connection_id, row.last_at]));
}
