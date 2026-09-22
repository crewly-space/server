import type { AgentRun } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { listProviderCallsForRun, type ProviderCallRecord } from '../gateway/meter.js';
import { listAgentRunsForRoot, listRunEvents, type RunEvent } from './runs.js';

export interface RunTreeNode {
  runId: string;
  causationId: string | null;
  hopCount: number;
  agentId: string;
  agentName: string | null;
  status: AgentRun['status'];
  trigger: string | undefined;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunSummary {
  durationMs: number | null;
  /** The provider and model that produced the answer, when one did. */
  provider: { providerId: string; model: string } | null;
  providerCalls: number;
  retries: number;
  fallbacks: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  unpricedCalls: number;
}

export interface RunTrace {
  run: AgentRun & { agentName: string | null };
  summary: RunSummary;
  events: RunEvent[];
  providerCalls: ProviderCallRecord[];
  approvals: Array<{ id: string; action: string; status: string; createdAt: string; resolvedAt: string | null }>;
  runtimeSessions: Array<{ id: string; runtimeKind: string; workspacePath: string; status: string; updatedAt: string }>;
  /** Every run in the same chain -- the root, and whatever it delegated -- oldest first. */
  tree: RunTreeNode[];
  /** Spend across the whole chain, so delegated work is visible where it was asked for. */
  treeCostMicros: number;
}

function agentName(db: Database, agentId: string): string | null {
  const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
  return row?.name ?? null;
}

/**
 * Everything worth knowing about why a run went the way it did, assembled
 * from the run row, its trace, the gateway's meter, approvals and runtime
 * sessions. None of it contains prompt, completion or tool content: the
 * trace only ever stored metadata, so there is nothing here to redact.
 */
export function buildRunTrace(db: Database, run: AgentRun): RunTrace {
  const events = listRunEvents(db, run.runId);
  const providerCalls = listProviderCallsForRun(db, run.runId);
  const answered = [...providerCalls].reverse().find((call) => call.status === 'ok');

  const approvals = (db
    .prepare('SELECT id, action, status, created_at, resolved_at FROM approvals WHERE run_id = ? ORDER BY created_at')
    .all(run.runId) as Array<{ id: string; action: string; status: string; created_at: string; resolved_at: string | null }>)
    .map((row) => ({ id: row.id, action: row.action, status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at }));

  const runtimeSessions = (db
    .prepare(
      `SELECT s.id, b.runtime_kind, b.workspace_path, s.status, s.updated_at
       FROM runtime_sessions s JOIN runtime_bindings b ON b.id = s.runtime_binding_id
       WHERE s.agent_id = ? AND s.conversation_id = ? ORDER BY s.updated_at DESC`,
    )
    .all(run.agentId, run.conversationId) as Array<{ id: string; runtime_kind: string; workspace_path: string; status: string; updated_at: string }>)
    .map((row) => ({ id: row.id, runtimeKind: row.runtime_kind, workspacePath: row.workspace_path, status: row.status, updatedAt: row.updated_at }));

  const tree = listAgentRunsForRoot(db, run.rootRunId).map((node): RunTreeNode => ({
    runId: node.runId,
    causationId: node.causationId,
    hopCount: node.hopCount,
    agentId: node.agentId,
    agentName: agentName(db, node.agentId),
    status: node.status,
    trigger: node.trigger,
    createdAt: node.createdAt,
    finishedAt: node.finishedAt ?? null,
  }));
  const { cost } = db
    .prepare('SELECT COALESCE(SUM(cost_micros), 0) AS cost FROM provider_calls WHERE root_run_id = ?')
    .get(run.rootRunId) as { cost: number };

  const started = run.startedAt ?? run.createdAt;
  return {
    run: { ...run, agentName: agentName(db, run.agentId) },
    summary: {
      durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(started) : null,
      provider: answered ? { providerId: answered.providerId, model: answered.model } : null,
      providerCalls: providerCalls.length,
      retries: events.filter((event) => event.type === 'provider.retry').length,
      fallbacks: events.filter((event) => event.type === 'provider.fallback').length,
      toolCalls: events.filter((event) => event.type === 'tool.call').length,
      inputTokens: providerCalls.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: providerCalls.reduce((sum, call) => sum + call.outputTokens, 0),
      costMicros: providerCalls.reduce((sum, call) => sum + (call.costMicros ?? 0), 0),
      unpricedCalls: providerCalls.filter((call) => call.status === 'ok' && call.costMicros === null).length,
    },
    events,
    providerCalls,
    approvals,
    runtimeSessions,
    tree,
    treeCostMicros: cost,
  };
}
