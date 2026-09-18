import { AgentRunSchema, type AgentRun } from '../protocol/index.js';
import type { Database } from '../db/driver.js';

interface AgentRunRow {
  run_id: string;
  root_run_id: string;
  causation_id: string | null;
  hop_count: number;
  agent_id: string;
  conversation_id: string;
  created_at: string;
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
  }
): AgentRun {
  const row: AgentRunRow = {
    run_id: input.runId,
    root_run_id: input.rootRunId,
    causation_id: input.causationId,
    hop_count: input.hopCount,
    agent_id: input.agentId,
    conversation_id: input.conversationId,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO agent_runs (run_id, root_run_id, causation_id, hop_count, agent_id, conversation_id, created_at)
     VALUES (@run_id, @root_run_id, @causation_id, @hop_count, @agent_id, @conversation_id, @created_at)`
  ).run(row);
  return rowToAgentRun(row);
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
