import { randomUUID } from 'node:crypto';
import { emitNotification } from '../notifications/service.js';
import type { Database } from '../db/driver.js';
import type { AiGateway, GatewayGuard } from '../gateway/gateway.js';
import type { ProviderCallRecord } from '../gateway/meter.js';
import { ProviderError } from '../providers/errors.js';
import type { ConnectionHub } from '../ws/hub.js';

export type BudgetScope = 'server' | 'agent';
export type BudgetPeriod = 'daily' | 'monthly';
export type BudgetAction = 'warn' | 'block' | 'fallback';

export interface Budget {
  id: string;
  scope: BudgetScope;
  agentId: string | null;
  period: BudgetPeriod;
  limitMicros: number;
  action: BudgetAction;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetStatus extends Budget {
  periodStart: string;
  periodEnd: string;
  spentMicros: number;
  /** Spent as a share of the limit, 0..∞. */
  ratio: number;
  exceeded: boolean;
}

/** The thresholds people are told about, as percentages of the limit. */
export const ALERT_THRESHOLDS = [80, 100] as const;

/** A run refused because the money set aside for it is spent. */
export class BudgetExceededError extends ProviderError {
  override readonly code: string = 'budget_exceeded';
}

interface BudgetRow {
  id: string;
  scope: BudgetScope;
  agent_id: string | null;
  period: BudgetPeriod;
  limit_micros: number;
  action: BudgetAction;
  created_at: string;
  updated_at: string;
}

function rowToBudget(row: BudgetRow): Budget {
  return {
    id: row.id,
    scope: row.scope,
    agentId: row.agent_id,
    period: row.period,
    limitMicros: row.limit_micros,
    action: row.action,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Budgets run on UTC days and months, so everyone on a server shares one boundary. */
export function periodBounds(period: BudgetPeriod, now: Date): { start: Date; end: Date } {
  const start = period === 'daily'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = period === 'daily'
    ? new Date(start.getTime() + 24 * 60 * 60 * 1000)
    : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end };
}

export function createBudget(
  db: Database,
  input: { scope: BudgetScope; agentId?: string | null; period: BudgetPeriod; limitMicros: number; action: BudgetAction; createdBy?: string },
): Budget {
  const now = new Date().toISOString();
  const row: BudgetRow = {
    id: randomUUID(),
    scope: input.scope,
    agent_id: input.scope === 'agent' ? input.agentId ?? null : null,
    period: input.period,
    limit_micros: input.limitMicros,
    action: input.action,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO budgets (id, scope, agent_id, period, limit_micros, action, created_by, created_at, updated_at)
     VALUES (@id, @scope, @agent_id, @period, @limit_micros, @action, @created_by, @created_at, @updated_at)`,
  ).run({ ...row, created_by: input.createdBy ?? null });
  return rowToBudget(row);
}

export function getBudget(db: Database, id: string): Budget | undefined {
  const row = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as BudgetRow | undefined;
  return row ? rowToBudget(row) : undefined;
}

export function listBudgets(db: Database): Budget[] {
  return (db.prepare("SELECT * FROM budgets ORDER BY scope DESC, period, created_at").all() as BudgetRow[]).map(rowToBudget);
}

export function updateBudget(
  db: Database,
  id: string,
  input: { limitMicros?: number; action?: BudgetAction },
): Budget | undefined {
  const existing = getBudget(db, id);
  if (!existing) return undefined;
  db.prepare('UPDATE budgets SET limit_micros = ?, action = ?, updated_at = ? WHERE id = ?').run(
    input.limitMicros ?? existing.limitMicros,
    input.action ?? existing.action,
    new Date().toISOString(),
    id,
  );
  return getBudget(db, id);
}

export function deleteBudget(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM budgets WHERE id = ?').run(id).changes > 0;
}

export function spentSince(db: Database, since: Date, agentId?: string | null): number {
  const row = agentId
    ? db.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM provider_calls WHERE created_at >= ? AND agent_id = ?')
      .get(since.toISOString(), agentId)
    : db.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM provider_calls WHERE created_at >= ?')
      .get(since.toISOString());
  return (row as { spent: number }).spent;
}

export function budgetStatus(db: Database, budget: Budget, now = new Date()): BudgetStatus {
  const { start, end } = periodBounds(budget.period, now);
  const spentMicros = spentSince(db, start, budget.scope === 'agent' ? budget.agentId : null);
  return {
    ...budget,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    spentMicros,
    ratio: spentMicros / budget.limitMicros,
    exceeded: spentMicros >= budget.limitMicros,
  };
}

/** The budgets that cover a call on behalf of this agent: the server's, and the agent's own. */
function budgetsFor(db: Database, agentId: string | undefined): Budget[] {
  const rows = agentId
    ? db.prepare("SELECT * FROM budgets WHERE scope = 'server' OR agent_id = ?").all(agentId)
    : db.prepare("SELECT * FROM budgets WHERE scope = 'server'").all();
  return (rows as BudgetRow[]).map(rowToBudget);
}

function describe(status: BudgetStatus): string {
  const whose = status.scope === 'server' ? 'The server' : 'This agent';
  const when = status.period === 'daily' ? 'daily' : 'monthly';
  return `${whose} has used its ${when} budget of $${(status.limitMicros / 1_000_000).toFixed(2)}`;
}

/**
 * The gateway guard that enforces budgets.
 *
 * A call is judged against every budget that covers it; the strictest verdict
 * wins. "fallback" lets the call through once it is already on the agent's
 * fallback model -- the point is to keep working on something cheaper.
 */
export function budgetGuard(db: Database, now: () => Date = () => new Date()): GatewayGuard {
  return (_target, context, { isFallback }) => {
    let fallbackReason: string | undefined;
    for (const budget of budgetsFor(db, context.agentId)) {
      if (budget.action === 'warn') continue;
      const status = budgetStatus(db, budget, now());
      if (!status.exceeded) continue;
      const reason = describe(status);
      if (budget.action === 'block') return { action: 'block', error: new BudgetExceededError(reason) };
      if (!isFallback) fallbackReason ??= reason;
    }
    if (fallbackReason) {
      return {
        action: 'fallback',
        reason: 'budget_exceeded',
        error: new BudgetExceededError(`${fallbackReason}, and it has no fallback model to move to`),
      };
    }
    return { action: 'allow' };
  };
}

export interface BudgetAlert {
  budgetId: string;
  scope: BudgetScope;
  agentId: string | null;
  period: BudgetPeriod;
  threshold: number;
  spentMicros: number;
  limitMicros: number;
  action: BudgetAction;
  periodStart: string;
}

/**
 * Tells the people who run the server when spending crosses 80% and 100% of
 * a budget. Each threshold is announced once per period.
 */
export function checkBudgetAlerts(db: Database, record: ProviderCallRecord, now = new Date()): BudgetAlert[] {
  if (!record.costMicros) return [];
  const raised: BudgetAlert[] = [];
  for (const budget of budgetsFor(db, record.agentId ?? undefined)) {
    const status = budgetStatus(db, budget, now);
    for (const threshold of ALERT_THRESHOLDS) {
      if (status.ratio * 100 < threshold) continue;
      const inserted = db.prepare(
        `INSERT OR IGNORE INTO budget_alerts (budget_id, period_start, threshold, spent_micros, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(budget.id, status.periodStart, threshold, status.spentMicros, now.toISOString());
      if (inserted.changes === 0) continue;
      raised.push({
        budgetId: budget.id,
        scope: budget.scope,
        agentId: budget.agentId,
        period: budget.period,
        threshold,
        spentMicros: status.spentMicros,
        limitMicros: budget.limitMicros,
        action: budget.action,
        periodStart: status.periodStart,
      });
    }
  }
  return raised;
}

/** Budgets on the gateway: prices, the guard, and alerts to every owner and admin. */
export function installBudgets(db: Database, gateway: AiGateway, hub: ConnectionHub, pricer: Parameters<AiGateway['setPricer']>[0]): void {
  gateway.setPricer(pricer);
  gateway.use(budgetGuard(db));
  gateway.onCall((record) => {
    const alerts = checkBudgetAlerts(db, record);
    if (alerts.length === 0) return;
    const admins = db.prepare("SELECT id FROM users WHERE role IN ('owner', 'admin') AND suspended_at IS NULL").all() as { id: string }[];
    for (const alert of alerts) {
      for (const admin of admins) hub.publish(`user:${admin.id}`, 'budget.threshold', { ...alert });
      const percent = Math.round(alert.threshold * 100);
      void emitNotification(db, {
        type: 'billing.warning',
        recipients: admins.map((admin) => ({ userId: admin.id })),
        dedupeKey: `budget:${alert.budgetId}:${alert.periodStart}:${alert.threshold}`,
        title: `A ${alert.period} budget reached ${percent}%`,
        body: `Spent $${(alert.spentMicros / 1e6).toFixed(2)} of $${(alert.limitMicros / 1e6).toFixed(2)}${alert.action === 'block' ? '; calls stop at the limit' : ''}.`,
      });
    }
  });
}
