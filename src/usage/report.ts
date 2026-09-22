import type { Database } from '../db/driver.js';
import type { ProviderCallRecord } from '../gateway/meter.js';

export type UsageGrouping = 'agent' | 'provider' | 'model' | 'day';

export interface UsageRow {
  /** The agent id, provider id, `kind/model` or `YYYY-MM-DD`, by grouping. */
  key: string;
  /** Something to show for it: the agent's name, when there is one. */
  label: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  /** Calls whose model has no price, so costMicros understates them. */
  unpricedCalls: number;
}

export interface UsageReport {
  from: string;
  to: string;
  groupBy: UsageGrouping;
  totals: Omit<UsageRow, 'key' | 'label'>;
  rows: UsageRow[];
}

const GROUP_EXPRESSIONS: Record<UsageGrouping, string> = {
  agent: "COALESCE(c.agent_id, '')",
  provider: 'c.provider_id',
  model: "c.provider_kind || '/' || c.model",
  day: 'substr(c.created_at, 1, 10)',
};

const AGGREGATES = `
  COUNT(*) AS calls,
  SUM(CASE WHEN c.status = 'error' THEN 1 ELSE 0 END) AS errors,
  COALESCE(SUM(c.input_tokens), 0) AS inputTokens,
  COALESCE(SUM(c.output_tokens), 0) AS outputTokens,
  COALESCE(SUM(c.cost_micros), 0) AS costMicros,
  SUM(CASE WHEN c.status = 'ok' AND c.cost_micros IS NULL THEN 1 ELSE 0 END) AS unpricedCalls`;

/**
 * Spend and traffic over a window, grouped one way.
 *
 * Read straight from the gateway's meter, so a self-hosted server sees its
 * usage without any billing system in the loop.
 */
export function usageReport(
  db: Database,
  input: { from: Date; to: Date; groupBy: UsageGrouping; agentId?: string },
): UsageReport {
  const where = ['c.created_at >= ?', 'c.created_at < ?'];
  const params: unknown[] = [input.from.toISOString(), input.to.toISOString()];
  if (input.agentId) {
    where.push('c.agent_id = ?');
    params.push(input.agentId);
  }
  const group = GROUP_EXPRESSIONS[input.groupBy];
  const rows = db
    .prepare(
      `SELECT ${group} AS key, a.name AS agentName, ${AGGREGATES}
       FROM provider_calls c LEFT JOIN agents a ON a.id = c.agent_id
       WHERE ${where.join(' AND ')}
       GROUP BY ${group}
       ORDER BY costMicros DESC, calls DESC`,
    )
    .all(...params) as Array<Omit<UsageRow, 'label'> & { agentName: string | null }>;
  const totals = db
    .prepare(`SELECT ${AGGREGATES} FROM provider_calls c WHERE ${where.join(' AND ')}`)
    .get(...params) as UsageReport['totals'];

  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    groupBy: input.groupBy,
    totals: { ...totals, errors: totals.errors ?? 0, unpricedCalls: totals.unpricedCalls ?? 0 },
    rows: rows.map(({ agentName, ...row }) => ({
      ...row,
      label: input.groupBy === 'agent' ? agentName ?? (row.key ? 'Deleted agent' : 'No agent') : row.key,
    })),
  };
}

/**
 * The raw meter, a page at a time, oldest first -- for something outside the
 * server (Crewly Cloud's billing, a spreadsheet) to consume the same records.
 */
export function exportProviderCalls(
  db: Database,
  input: { after?: string; limit: number },
): { calls: ProviderCallRecord[]; next: string | null } {
  // The cursor is `created_at|id`, which is unique and in insertion order.
  const [afterAt, afterId] = input.after ? input.after.split('|') : ['', ''];
  const rows = db
    .prepare(
      `SELECT * FROM provider_calls
       WHERE created_at > ? OR (created_at = ? AND id > ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(afterAt, afterAt, afterId, input.limit + 1) as Array<Record<string, unknown>>;
  const page = rows.slice(0, input.limit).map((row) => ({
    id: row.id as string,
    providerId: row.provider_id as string,
    providerKind: row.provider_kind as string,
    model: row.model as string,
    purpose: row.purpose as string,
    agentId: row.agent_id as string | null,
    runId: row.run_id as string | null,
    rootRunId: row.root_run_id as string | null,
    conversationId: row.conversation_id as string | null,
    attempt: row.attempt as number,
    fallback: row.fallback === 1,
    status: row.status as 'ok' | 'error',
    errorCode: row.error_code as string | null,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    costMicros: row.cost_micros as number | null,
    latencyMs: row.latency_ms as number,
    createdAt: row.created_at as string,
  }));
  const last = page[page.length - 1];
  return { calls: page, next: rows.length > input.limit && last ? `${last.createdAt}|${last.id}` : null };
}
