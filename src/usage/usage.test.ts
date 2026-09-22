import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAgent } from '../agents/repository.js';
import { createSession } from '../auth/session.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { AiGateway } from '../gateway/gateway.js';
import { createProviderConfig } from '../providers/repository.js';
import { createUser } from '../users/repository.js';
import type { ConnectionHub } from '../ws/hub.js';
import { budgetGuard, checkBudgetAlerts, createBudget, installBudgets, periodBounds } from './budgets.js';
import { priceCall, setModelPrice } from './pricing.js';

function fresh() {
  const db = openSqlite(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const owner = createUser(db, { email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
  const agent = createAgent(db, {
    ownerUserId: owner.id,
    name: 'Researcher',
    personality: '',
    modelPolicy: { defaultProviderId: 'primary', defaultModel: 'claude-haiku-4-5' },
    permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
  });
  return { db, owner, agent };
}

/** Spend `micros` on behalf of an agent, as the gateway's meter would record it. */
function spend(db: Database, agentId: string | null, micros: number, at = new Date()) {
  db.prepare(
    `INSERT INTO provider_calls (id, provider_id, provider_kind, model, purpose, agent_id, attempt, status, cost_micros, input_tokens, output_tokens, latency_ms, created_at)
     VALUES (lower(hex(randomblob(8))), 'primary', 'anthropic', 'claude-haiku-4-5', 'agent_turn', ?, 1, 'ok', ?, 100, 50, 10, ?)`,
  ).run(agentId, micros, at.toISOString());
}

const target = { providerId: 'primary', model: 'claude-haiku-4-5' };

describe('pricing', () => {
  let db: Database;
  beforeEach(() => ({ db } = fresh()));
  afterEach(() => db.close());

  it('prices a listed model per million tokens, in micro-dollars', () => {
    // Haiku 4.5 lists at $1 in / $5 out per million tokens.
    expect(priceCall(db, 'anthropic', 'claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBe(1_500_000);
  });

  it('recognises an OpenRouter model by its bare name', () => {
    expect(priceCall(db, 'openrouter', 'openai/gpt-4o-mini', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(150_000);
  });

  it('prefers a price an admin set', () => {
    setModelPrice(db, { providerKind: 'anthropic', model: 'claude-haiku-4-5', inputPerMTokUsd: 0.5, outputPerMTokUsd: 2 });
    expect(priceCall(db, 'anthropic', 'claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(2_500_000);
  });

  it('leaves a model it does not know unpriced rather than guessing', () => {
    expect(priceCall(db, 'openai-compatible', 'my-finetune', { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it('charges nothing for a subscription or a local model', () => {
    expect(priceCall(db, 'claude-subscription', 'claude-sonnet-5', { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
    expect(priceCall(db, 'ollama', 'llama3', { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
  });
});

describe('budget periods', () => {
  it('runs on UTC days and calendar months', () => {
    const now = new Date('2026-03-31T23:30:00Z');
    expect(periodBounds('daily', now)).toEqual({ start: new Date('2026-03-31T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') });
    expect(periodBounds('monthly', now)).toEqual({ start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') });
  });
});

describe('budget guard', () => {
  let db: Database;
  let agentId: string;
  beforeEach(() => {
    const setup = fresh();
    db = setup.db;
    agentId = setup.agent.id;
  });
  afterEach(() => db.close());

  const context = () => ({ purpose: 'agent_turn', ownerUserId: 'o', agentId });

  it('lets calls through while there is money left', () => {
    createBudget(db, { scope: 'server', period: 'daily', limitMicros: 1_000_000, action: 'block' });
    spend(db, agentId, 999_999);
    expect(budgetGuard(db)(target, context(), { isFallback: false })).toEqual({ action: 'allow' });
  });

  it('blocks once a blocking budget is spent, and says which', () => {
    createBudget(db, { scope: 'server', period: 'daily', limitMicros: 1_000_000, action: 'block' });
    spend(db, agentId, 1_000_000);
    const verdict = budgetGuard(db)(target, context(), { isFallback: false });
    expect(verdict).toMatchObject({ action: 'block' });
    expect(verdict.action === 'block' && verdict.error).toMatchObject({
      code: 'budget_exceeded',
      message: 'The server has used its daily budget of $1.00',
    });
  });

  it('only warns for a warning budget', () => {
    createBudget(db, { scope: 'server', period: 'daily', limitMicros: 1, action: 'warn' });
    spend(db, agentId, 10);
    expect(budgetGuard(db)(target, context(), { isFallback: false })).toEqual({ action: 'allow' });
  });

  it('moves a spent agent to its fallback model, and lets the fallback through', () => {
    createBudget(db, { scope: 'agent', agentId, period: 'monthly', limitMicros: 100, action: 'fallback' });
    spend(db, agentId, 100);
    expect(budgetGuard(db)(target, context(), { isFallback: false })).toMatchObject({ action: 'fallback', reason: 'budget_exceeded' });
    expect(budgetGuard(db)(target, context(), { isFallback: true })).toEqual({ action: 'allow' });
  });

  it('holds an agent budget to that agent’s spending only', () => {
    createBudget(db, { scope: 'agent', agentId, period: 'daily', limitMicros: 100, action: 'block' });
    spend(db, null, 10_000);
    spend(db, 'another-agent', 10_000);
    expect(budgetGuard(db)(target, context(), { isFallback: false })).toEqual({ action: 'allow' });
  });

  it('starts every day fresh', () => {
    createBudget(db, { scope: 'server', period: 'daily', limitMicros: 100, action: 'block' });
    spend(db, agentId, 10_000, new Date(Date.now() - 36 * 60 * 60 * 1000));
    expect(budgetGuard(db)(target, context(), { isFallback: false })).toEqual({ action: 'allow' });
  });
});

describe('budget alerts', () => {
  it('announces 80% and 100% once each per period', () => {
    const { db, agent } = fresh();
    createBudget(db, { scope: 'server', period: 'monthly', limitMicros: 1000, action: 'warn' });
    const record = { costMicros: 1, agentId: agent.id } as Parameters<typeof checkBudgetAlerts>[1];

    spend(db, agent.id, 700);
    expect(checkBudgetAlerts(db, record)).toEqual([]);
    spend(db, agent.id, 150);
    expect(checkBudgetAlerts(db, record).map((a) => a.threshold)).toEqual([80]);
    expect(checkBudgetAlerts(db, record)).toEqual([]);
    spend(db, agent.id, 200);
    expect(checkBudgetAlerts(db, record)).toMatchObject([{ threshold: 100, spentMicros: 1050, limitMicros: 1000 }]);
    db.close();
  });

  it('reaches every owner and admin through the gateway', async () => {
    const { db, owner, agent } = fresh();
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk' });
    createBudget(db, { scope: 'agent', agentId: agent.id, period: 'daily', limitMicros: 10, action: 'warn' });
    const published: Array<{ topic: string; type: string }> = [];
    const hub = { publish: (topic: string, type: string) => published.push({ topic, type }) } as unknown as ConnectionHub;
    const gateway = new AiGateway({
      db,
      fetchImpl: (async () => new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 100 },
      }))) as unknown as typeof fetch,
    });
    installBudgets(db, gateway, hub, (kind, model, usage) => priceCall(db, kind, model, usage));

    await gateway.chat({
      target,
      messages: [{ role: 'user', content: 'hi' }],
      context: { purpose: 'agent_turn', ownerUserId: owner.id, agentId: agent.id },
    });

    // 100 in + 100 out on Haiku is 600 micro-dollars: past both thresholds at once.
    expect(db.prepare('SELECT cost_micros FROM provider_calls').get()).toEqual({ cost_micros: 600 });
    expect(published).toEqual([
      { topic: `user:${owner.id}`, type: 'budget.threshold' },
      { topic: `user:${owner.id}`, type: 'budget.threshold' },
    ]);
    db.close();
  });
});

describe('usage and budget routes', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken: string;
  let memberToken: string;
  let agentId: string;

  beforeEach(async () => {
    const setup = fresh();
    db = setup.db;
    agentId = setup.agent.id;
    app = await buildApp({ db });
    ownerToken = createSession(db, setup.owner.id);
    const member = createUser(db, { email: 'member@example.com', displayName: 'Member', passwordHash: 'x', role: 'member' });
    memberToken = createSession(db, member.id);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  it('keeps spending out of a member’s reach', async () => {
    for (const url of ['/api/v1/usage', '/api/v1/budgets', '/api/v1/usage/prices', '/api/v1/usage/calls']) {
      expect((await app.inject({ method: 'GET', url, headers: as(memberToken) })).statusCode, url).toBe(403);
    }
  });

  it('reports usage by agent, named', async () => {
    spend(db, agentId, 300);
    spend(db, agentId, 200);
    spend(db, null, 50);
    const response = await app.inject({ method: 'GET', url: '/api/v1/usage?groupBy=agent', headers: as(ownerToken) });
    expect(response.statusCode).toBe(200);
    expect(response.json().totals).toMatchObject({ calls: 3, costMicros: 550, inputTokens: 300, outputTokens: 150 });
    expect(response.json().rows).toMatchObject([
      { key: agentId, label: 'Researcher', calls: 2, costMicros: 500 },
      { key: '', label: 'No agent', calls: 1, costMicros: 50 },
    ]);
  });

  it('sets a budget in dollars and shows what has been spent against it', async () => {
    spend(db, agentId, 250_000);
    const created = await app.inject({
      method: 'POST', url: '/api/v1/budgets', headers: as(ownerToken),
      payload: { scope: 'agent', agentId, period: 'monthly', limitUsd: 1, action: 'block' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ limitMicros: 1_000_000, limitUsd: 1, spentMicros: 250_000, spentUsd: 0.25, ratio: 0.25, exceeded: false });

    const duplicate = await app.inject({
      method: 'POST', url: '/api/v1/budgets', headers: as(ownerToken),
      payload: { scope: 'agent', agentId, period: 'monthly', limitUsd: 5 },
    });
    expect(duplicate.statusCode).toBe(409);

    const raised = await app.inject({
      method: 'PATCH', url: `/api/v1/budgets/${created.json().id}`, headers: as(ownerToken), payload: { limitUsd: 0.2 },
    });
    expect(raised.json()).toMatchObject({ exceeded: true });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/budgets', headers: as(ownerToken) });
    expect(listed.json().budgets).toHaveLength(1);

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/budgets/${created.json().id}`, headers: as(ownerToken) })).statusCode).toBe(204);
  });

  it('refuses a server budget that names an agent', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/budgets', headers: as(ownerToken),
      payload: { scope: 'server', agentId, period: 'daily', limitUsd: 1 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('lets an admin price a model the list does not know', async () => {
    const set = await app.inject({
      method: 'PUT', url: '/api/v1/usage/prices', headers: as(ownerToken),
      payload: { providerKind: 'openai-compatible', model: 'my-finetune', inputPerMTokUsd: 0.2, outputPerMTokUsd: 0.4 },
    });
    expect(set.json()).toMatchObject({ source: 'custom', inputPerMTokUsd: 0.2 });
    const prices = await app.inject({ method: 'GET', url: '/api/v1/usage/prices', headers: as(ownerToken) });
    expect(prices.json().prices[0]).toMatchObject({ model: 'my-finetune' });
  });

  it('pages through the raw meter for an outside consumer', async () => {
    for (let i = 0; i < 3; i += 1) spend(db, agentId, i, new Date(Date.now() - (3 - i) * 1000));
    const first = await app.inject({ method: 'GET', url: '/api/v1/usage/calls?limit=2', headers: as(ownerToken) });
    expect(first.json().calls).toHaveLength(2);
    expect(first.json().next).toBeTruthy();
    const second = await app.inject({
      method: 'GET', url: `/api/v1/usage/calls?limit=2&after=${encodeURIComponent(first.json().next)}`, headers: as(ownerToken),
    });
    expect(second.json().calls).toHaveLength(1);
    expect(second.json().next).toBeNull();
    expect(second.json().calls[0].costMicros).toBe(2);
  });
});
