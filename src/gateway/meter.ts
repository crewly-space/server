import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';

export interface ProviderCallRecord {
  id: string;
  providerId: string;
  providerKind: string;
  model: string;
  purpose: string;
  agentId: string | null;
  runId: string | null;
  rootRunId: string | null;
  conversationId: string | null;
  attempt: number;
  fallback: boolean;
  status: 'ok' | 'error';
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number | null;
  latencyMs: number;
  createdAt: string;
}

interface ProviderCallRow {
  id: string;
  provider_id: string;
  provider_kind: string;
  model: string;
  purpose: string;
  agent_id: string | null;
  run_id: string | null;
  root_run_id: string | null;
  conversation_id: string | null;
  attempt: number;
  fallback: number;
  status: 'ok' | 'error';
  error_code: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number | null;
  latency_ms: number;
  created_at: string;
}

function rowToRecord(row: ProviderCallRow): ProviderCallRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerKind: row.provider_kind,
    model: row.model,
    purpose: row.purpose,
    agentId: row.agent_id,
    runId: row.run_id,
    rootRunId: row.root_run_id,
    conversationId: row.conversation_id,
    attempt: row.attempt,
    fallback: row.fallback === 1,
    status: row.status,
    errorCode: row.error_code,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMicros: row.cost_micros,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

export function recordProviderCall(
  db: Database,
  input: Omit<ProviderCallRecord, 'id' | 'createdAt'> & { createdAt?: string },
): ProviderCallRecord {
  const record: ProviderCallRecord = {
    ...input,
    id: randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO provider_calls (id, provider_id, provider_kind, model, purpose, agent_id, run_id, root_run_id,
       conversation_id, attempt, fallback, status, error_code, input_tokens, output_tokens, cost_micros, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id, record.providerId, record.providerKind, record.model, record.purpose, record.agentId, record.runId,
    record.rootRunId, record.conversationId, record.attempt, record.fallback ? 1 : 0, record.status, record.errorCode,
    record.inputTokens, record.outputTokens, record.costMicros, record.latencyMs, record.createdAt,
  );
  return record;
}

export function listProviderCallsForRun(db: Database, runId: string): ProviderCallRecord[] {
  const rows = db
    .prepare('SELECT * FROM provider_calls WHERE run_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(runId) as ProviderCallRow[];
  return rows.map(rowToRecord);
}

export function listRecentProviderCalls(db: Database, providerId: string, since: string, limit = 200): ProviderCallRecord[] {
  const rows = db
    .prepare(
      'SELECT * FROM provider_calls WHERE provider_id = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    )
    .all(providerId, since, limit) as ProviderCallRow[];
  return rows.map(rowToRecord);
}
