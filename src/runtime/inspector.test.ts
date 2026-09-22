import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAgent } from '../agents/repository.js';
import { createSession } from '../auth/session.js';
import { createConversation } from '../conversations/repository.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { AiGateway } from '../gateway/gateway.js';
import { createProviderConfig } from '../providers/repository.js';
import { createUser } from '../users/repository.js';
import { createAgentRun } from './runs.js';

type Reply = Response | Error;

describe('run inspector', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let replies: Reply[];
  let ownerToken: string;
  let strangerToken: string;
  let agentId: string;
  let conversationId: string;

  const anthropic = (text: string) =>
    new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } }));

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    replies = [];
    const fetchImpl = (async () => {
      const next = replies.shift();
      if (!next) throw new Error('no reply scripted');
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    const gateway = new AiGateway({ db, fetchImpl, sleep: async () => {} });
    app = await buildApp({ db, gateway });

    const owner = createUser(db, { email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    const stranger = createUser(db, { email: 'stranger@example.com', displayName: 'Stranger', passwordHash: 'x', role: 'member' });
    ownerToken = createSession(db, owner.id);
    strangerToken = createSession(db, stranger.id);
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'sk' });
    agentId = createAgent(db, {
      ownerUserId: owner.id,
      name: 'Helper',
      personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-haiku-4-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    }).id;
    conversationId = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: owner.id, participantType: 'user' },
        { participantId: agentId, participantType: 'agent' },
      ],
    }).id;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  async function send(body: string) {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/conversations/${conversationId}/messages`, headers: as(ownerToken), payload: { body },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function settled(messageId: string) {
    for (let i = 0; i < 100; i += 1) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/messages/${messageId}/run`, headers: as(ownerToken) });
      if (response.statusCode === 200 && ['completed', 'failed', 'cancelled'].includes(response.json().run.status)) {
        return response.json();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('run never finished');
  }

  it('explains a reply: which model, how long, what it cost, and what happened on the way', async () => {
    replies.push(new Error('ECONNRESET'), anthropic('Here you go'));
    const trace = await settled(await send('help'));

    expect(trace.run).toMatchObject({ status: 'completed', agentName: 'Helper', trigger: 'message', hopCount: 0 });
    expect(trace.summary).toMatchObject({
      provider: { providerId: 'anthropic', model: 'claude-haiku-4-5' },
      providerCalls: 2,
      retries: 1,
      fallbacks: 0,
      inputTokens: 1000,
      outputTokens: 200,
      // Haiku 4.5: $1 + $5 per million → 1000 + 1000 micro-dollars.
      costMicros: 2000,
    });
    expect(trace.summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.events.map((e: { type: string }) => e.type)).toEqual([
      'run.started', 'provider.call', 'provider.retry', 'provider.call', 'run.completed',
    ]);
    expect(trace.tree).toMatchObject([{ runId: trace.run.runId, agentName: 'Helper', status: 'completed' }]);

    // The same trace is reachable from the agent's reply.
    const reply = await app.inject({ method: 'GET', url: `/api/v1/messages/${trace.run.resultMessageId}/run`, headers: as(ownerToken) });
    expect(reply.json().run.runId).toBe(trace.run.runId);
  });

  it('keeps no prompt or reply text in the trace', async () => {
    replies.push(anthropic('a secret answer'));
    const trace = await settled(await send('my secret question'));
    const serialized = JSON.stringify({ events: trace.events, providerCalls: trace.providerCalls });
    expect(serialized).not.toContain('secret');
  });

  it('records why a run failed, and links the failure to it', async () => {
    replies.push(new Response('{}', { status: 401 }));
    const trace = await settled(await send('hello?'));
    expect(trace.run).toMatchObject({ status: 'failed', errorCode: 'provider_auth_failed' });
    expect(trace.events.at(-1)).toMatchObject({ type: 'run.failed', data: { code: 'provider_auth_failed' } });

    const logs = await app.inject({ method: 'GET', url: '/api/v1/server/logs', headers: as(ownerToken) });
    expect(logs.json().entries).toContainEqual(expect.objectContaining({
      kind: 'agent_run_failed', subject: 'Helper', runId: trace.run.runId,
    }));
    const failed = await app.inject({ method: 'GET', url: '/api/v1/runs?status=failed', headers: as(ownerToken) });
    expect(failed.json().runs.map((r: { runId: string }) => r.runId)).toEqual([trace.run.runId]);
  });

  it('does not show a run to someone outside its conversation', async () => {
    replies.push(anthropic('ok'));
    const trace = await settled(await send('hi'));
    const response = await app.inject({ method: 'GET', url: `/api/v1/runs/${trace.run.runId}`, headers: as(strangerToken) });
    expect(response.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/v1/runs', headers: as(strangerToken) });
    expect(list.statusCode).toBe(403);
  });

  it('cancels a run and everything it started', async () => {
    const root = createAgentRun(db, { runId: 'root', rootRunId: 'root', causationId: null, hopCount: 0, agentId, conversationId });
    createAgentRun(db, { runId: 'child', rootRunId: 'root', causationId: 'root', hopCount: 1, agentId, conversationId });
    createAgentRun(db, { runId: 'grandchild', rootRunId: 'root', causationId: 'child', hopCount: 2, agentId, conversationId });

    const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${root.runId}/cancel`, headers: as(ownerToken) });
    expect(response.json().cancelled.sort()).toEqual(['child', 'grandchild', 'root']);
    const trace = await app.inject({ method: 'GET', url: '/api/v1/runs/child', headers: as(ownerToken) });
    expect(trace.json().run.status).toBe('cancelled');
    expect(trace.json().tree.map((n: { runId: string }) => n.runId)).toEqual(['root', 'child', 'grandchild']);
  });
});
