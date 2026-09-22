import { AgentRunSchema, type AgentRun, type AgentRunStatus } from '../protocol/index.js';
import type { Database } from '../db/driver.js';

interface AgentRunRow {
  run_id: string;
  root_run_id: string;
  causation_id: string | null;
  hop_count: number;
  agent_id: string;
  conversation_id: string;
  created_at: string;
  status: AgentRunStatus;
  trigger: string;
  trigger_message_id: string | null;
  result_message_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

function rowToAgentRun(row: AgentRunRow): AgentRun {
  return AgentRunSchema.parse({
    runId: row.run_id,
    rootRunId: row.root_run_id,
    causationId: row.causation_id,
    hopCount: row.hop_count,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    status: row.status,
    trigger: row.trigger,
    triggerMessageId: row.trigger_message_id,
    resultMessageId: row.result_message_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  });
}

export function createAgentRun(
  db: Database,
  input: {
    runId: string;
    rootRunId: string;
    causationId: string | null;
    hopCount: number;
    agentId: string;
    conversationId: string;
    status?: AgentRunStatus;
    trigger?: string;
    triggerMessageId?: string | null;
  }
): AgentRun {
  const now = new Date().toISOString();
  const status = input.status ?? 'running';
  db.prepare(
    `INSERT INTO agent_runs (run_id, root_run_id, causation_id, hop_count, agent_id, conversation_id, created_at,
       status, trigger, trigger_message_id, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId, input.rootRunId, input.causationId, input.hopCount, input.agentId, input.conversationId, now,
    status, input.trigger ?? 'message', input.triggerMessageId ?? null, status === 'running' ? now : null,
  );
  return getAgentRun(db, input.runId)!;
}

export function getAgentRun(db: Database, runId: string): AgentRun | undefined {
  const row = db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId) as AgentRunRow | undefined;
  return row ? rowToAgentRun(row) : undefined;
}

export function listAgentRunsForRoot(db: Database, rootRunId: string): AgentRun[] {
  const rows = db
    .prepare('SELECT * FROM agent_runs WHERE root_run_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(rootRunId) as AgentRunRow[];
  return rows.map(rowToAgentRun);
}

export function findRunForMessage(db: Database, messageId: string): AgentRun | undefined {
  const row = db
    .prepare('SELECT * FROM agent_runs WHERE result_message_id = ? OR trigger_message_id = ? ORDER BY (result_message_id = ?) DESC, created_at DESC LIMIT 1')
    .get(messageId, messageId, messageId) as AgentRunRow | undefined;
  return row ? rowToAgentRun(row) : undefined;
}

export function listAgentRuns(
  db: Database,
  filter: { status?: AgentRunStatus; agentId?: string; conversationId?: string; limit: number },
): AgentRun[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.agentId) {
    where.push('agent_id = ?');
    params.push(filter.agentId);
  }
  if (filter.conversationId) {
    where.push('conversation_id = ?');
    params.push(filter.conversationId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM agent_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params, filter.limit) as AgentRunRow[];
  return rows.map(rowToAgentRun);
}

/** Moves a queued run to running; false when it was cancelled while it waited. */
export function startAgentRun(db: Database, runId: string): boolean {
  return db
    .prepare("UPDATE agent_runs SET status = 'running', started_at = ? WHERE run_id = ? AND status = 'queued'")
    .run(new Date().toISOString(), runId).changes > 0;
}

export function completeAgentRun(db: Database, runId: string, resultMessageId: string | null): void {
  db.prepare(
    "UPDATE agent_runs SET status = 'completed', result_message_id = ?, finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')",
  ).run(resultMessageId, new Date().toISOString(), runId);
}

export function failAgentRun(db: Database, runId: string, error: { code: string; message: string }): void {
  db.prepare(
    "UPDATE agent_runs SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')",
  ).run(error.code, error.message, new Date().toISOString(), runId);
}

/** Cancels a run that has not finished; returns whether anything changed. */
export function cancelAgentRun(db: Database, runId: string, reason: string): boolean {
  return db.prepare(
    "UPDATE agent_runs SET status = 'cancelled', error_code = 'cancelled', error_message = ?, finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')",
  ).run(reason, new Date().toISOString(), runId).changes > 0;
}

export function isRunCancelled(db: Database, runId: string): boolean {
  const row = db.prepare('SELECT status FROM agent_runs WHERE run_id = ?').get(runId) as { status: AgentRunStatus } | undefined;
  return row?.status === 'cancelled';
}

export interface RunEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export function appendRunEvent(db: Database, runId: string, type: string, data: Record<string, unknown> = {}): RunEvent {
  const at = new Date().toISOString();
  const append = db.transaction(() => {
    const { next } = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?')
      .get(runId) as { next: number };
    db.prepare('INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)').run(
      runId, next, type, JSON.stringify(data), at,
    );
    return next;
  });
  return { seq: append(), type, data, at };
}

export function listRunEvents(db: Database, runId: string): RunEvent[] {
  const rows = db
    .prepare('SELECT seq, type, data, created_at FROM run_events WHERE run_id = ? ORDER BY seq ASC')
    .all(runId) as Array<{ seq: number; type: string; data: string; created_at: string }>;
  return rows.map((row) => ({ seq: row.seq, type: row.type, data: JSON.parse(row.data), at: row.created_at }));
}
