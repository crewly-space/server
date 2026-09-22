import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export type UsageGrouping = 'agent' | 'provider' | 'model' | 'day';

export interface UsageTotals {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated spend in millionths of a US dollar. */
  costMicros: number;
  /** Calls to models with no price, which costMicros therefore leaves out. */
  unpricedCalls: number;
}

export interface UsageRow extends UsageTotals {
  key: string;
  label: string;
}

export interface UsageReport {
  from: string;
  to: string;
  groupBy: UsageGrouping;
  totals: UsageTotals;
  rows: UsageRow[];
}

/** One metered provider call, as the gateway recorded it. */
export interface ProviderCall {
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

export interface ModelPrice {
  /** `*` for a built-in list price, which applies whichever provider serves the model. */
  providerKind: string;
  model: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  source: 'list' | 'custom';
}

export type BudgetAction = 'warn' | 'block' | 'fallback';

export interface Budget {
  id: string;
  scope: 'server' | 'agent';
  agentId: string | null;
  period: 'daily' | 'monthly';
  limitMicros: number;
  limitUsd: number;
  action: BudgetAction;
  periodStart: string;
  periodEnd: string;
  spentMicros: number;
  spentUsd: number;
  ratio: number;
  exceeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBudgetInput {
  scope: 'server' | 'agent';
  agentId?: string;
  period: 'daily' | 'monthly';
  limitUsd: number;
  action?: BudgetAction;
}

/** The `budget.threshold` event payload owners and admins receive. */
export interface BudgetThresholdEvent {
  budgetId: string;
  scope: 'server' | 'agent';
  agentId: string | null;
  period: 'daily' | 'monthly';
  threshold: number;
  spentMicros: number;
  limitMicros: number;
  action: BudgetAction;
  periodStart: string;
}

/** Spend visibility and limits. Owners and admins only. */
export class UsageResource {
  constructor(private readonly http: HttpClient) {}

  report(input: { from?: string; to?: string; groupBy?: UsageGrouping; agentId?: string } = {}): Promise<UsageReport> {
    const query = new URLSearchParams(Object.entries(input).filter(([, v]) => v !== undefined) as [string, string][]);
    const suffix = query.toString();
    return this.http.request('GET', `/api/v1/usage${suffix ? `?${suffix}` : ''}`);
  }

  /** The raw meter, oldest first; pass `next` back as `after` for the following page. */
  calls(input: { after?: string; limit?: number } = {}): Promise<{ calls: ProviderCall[]; next: string | null }> {
    const query = new URLSearchParams();
    if (input.after) query.set('after', input.after);
    if (input.limit) query.set('limit', String(input.limit));
    const suffix = query.toString();
    return this.http.request('GET', `/api/v1/usage/calls${suffix ? `?${suffix}` : ''}`);
  }

  prices(): Promise<{ prices: ModelPrice[] }> {
    return this.http.request('GET', '/api/v1/usage/prices');
  }

  setPrice(input: Omit<ModelPrice, 'source'>): Promise<ModelPrice> {
    return this.http.request('PUT', '/api/v1/usage/prices', input);
  }

  deletePrice(providerKind: string, model: string): Promise<void> {
    return this.http.request(
      'DELETE',
      `/api/v1/usage/prices/${encodePathSegment(providerKind)}/${encodePathSegment(model)}`,
    );
  }

  budgets(): Promise<{ budgets: Budget[] }> {
    return this.http.request('GET', '/api/v1/budgets');
  }

  createBudget(input: CreateBudgetInput): Promise<Budget> {
    return this.http.request('POST', '/api/v1/budgets', input);
  }

  updateBudget(id: string, input: { limitUsd?: number; action?: BudgetAction }): Promise<Budget> {
    return this.http.request('PATCH', `/api/v1/budgets/${encodePathSegment(id)}`, input);
  }

  deleteBudget(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/budgets/${encodePathSegment(id)}`);
  }
}
