import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { setAgentRoutingMode } from '../agents/repository.js';
import { createProviderConfig } from '../providers/repository.js';
import type { RespondFn } from '../runtime/engine.js';

describe('message routes', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'sk-test' });
  });

  afterEach(() => {
    db.close();
  });

  async function setupOwnerAndBobDm(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const token = setup.json().token as string;
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: bob.id, participantType: 'user' },
    });
    return { token, conversationId: create.json().id as string };
  }

  it('posts a message and lists it back', async () => {
    const app = await buildApp({ db });
    const { token, conversationId } = await setupOwnerAndBobDm(app);

    const post = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'hello there' },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().body).toBe('hello there');

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    await app.close();
  });

  it('rejects posting a message from a non-participant', async () => {
    const app = await buildApp({ db });
    const { conversationId } = await setupOwnerAndBobDm(app);
    const outsider = createUser(db, { email: 'outsider@example.com', displayName: 'Outsider', passwordHash: 'x', role: 'member' });
    const outsiderToken = createSession(db, outsider.id);

    const post = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${outsiderToken}` },
      payload: { body: 'i should not be able to post here' },
    });
    expect(post.statusCode).toBe(403);

    await app.close();
  });

  it('rejects a reply that references a message outside the conversation with 400', async () => {
    const app = await buildApp({ db });
    const { token, conversationId } = await setupOwnerAndBobDm(app);
    const otherDm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: createUser(db, { email: 'carol@example.com', displayName: 'Carol', passwordHash: 'x', role: 'member' }).id, participantType: 'user' },
    });
    const elsewhere = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${otherDm.json().id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'lives elsewhere' },
    });

    const reply = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'wrong reply', replyToMessageId: elsewhere.json().id },
    });
    expect(reply.statusCode).toBe(400);

    await app.close();
  });

  it('enqueues a summarize-conversation job after a message is posted', async () => {
    const app = await buildApp({ db });
    const { token, conversationId } = await setupOwnerAndBobDm(app);

    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'hello' },
    });

    const row = db.prepare("SELECT type, status FROM jobs WHERE type = 'summarize-conversation'").get() as
      | { type: string; status: string }
      | undefined;
    expect(row?.status).toBe('pending');

    await app.close();
  });
  /**
   * Agent turns are started after the reply is sent, so a test has to wait for
   * them rather than read state straight after the request resolves.
   */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  function newAgent(ownerUserId: string, name: string, defaultProviderId = 'anthropic', personality = '') {
    return createAgent(db, {
      ownerUserId,
      name,
      personality,
      modelPolicy: { defaultProviderId, defaultModel: 'claude-sonnet-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
  }

  function failureEvents(): { code: string; agentId: string; error: string }[] {
    const rows = db
      .prepare("SELECT payload FROM event_log WHERE type = 'agent.run.failed' ORDER BY seq ASC")
      .all() as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload));
  }

  async function setupGroupWithAgents(
    app: Awaited<ReturnType<typeof buildApp>>,
    betaProviderId = 'anthropic'
  ) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const token = setup.json().token as string;
    const ownerId = setup.json().user.id as string;
    const alpha = newAgent(ownerId, 'Alpha');
    const beta = newAgent(ownerId, 'Beta', betaProviderId);
    const group = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Standup',
        participants: [
          { participantId: alpha.id, participantType: 'agent' },
          { participantId: beta.id, participantType: 'agent' },
        ],
      },
    });
    return { token, conversationId: group.json().id as string, alphaId: alpha.id, betaId: beta.id };
  }

  it('wakes only the agents mentioned in a group conversation', async () => {
    const asked: string[] = [];
    const respond: RespondFn = async ({ agentId }) => {
      asked.push(agentId);
      return { body: 'on it' };
    };
    const app = await buildApp({ db, respond });
    const { token, conversationId, alphaId } = await setupGroupWithAgents(app);

    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: '@Alpha can you take this?', mentions: [{ targetId: alphaId, targetType: 'agent' }] },
    });
    await settle();

    expect(asked).toEqual([alphaId]);

    await app.close();
  });

  it('leaves every agent asleep when a group message mentions none of them', async () => {
    const asked: string[] = [];
    const respond: RespondFn = async ({ agentId }) => {
      asked.push(agentId);
      return { body: 'on it' };
    };
    const app = await buildApp({ db, respond });
    const { token, conversationId } = await setupGroupWithAgents(app);

    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'just thinking out loud' },
    });
    await settle();

    expect(asked).toEqual([]);

    await app.close();
  });

  it('applies global routing modes once and records the decision in the run trace', async () => {
    const asked: string[] = [];
    const respond: RespondFn = async ({ agentId }) => {
      asked.push(agentId);
      return { body: 'on it' };
    };
    const app = await buildApp({ db, respond });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const token = setup.json().token as string;
    const ownerId = setup.json().user.id as string;
    const always = newAgent(ownerId, 'Always');
    const disabled = newAgent(ownerId, 'Disabled');
    setAgentRoutingMode(db, always.id, 'always', null, ownerId);
    setAgentRoutingMode(db, disabled.id, 'disabled', null, ownerId);
    const group = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Routing', participants: [
        { participantId: always.id, participantType: 'agent' },
        { participantId: disabled.id, participantType: 'agent' },
      ] },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${group.json().id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'one shared message' },
    });
    await settle();

    expect(asked).toEqual([always.id]);
    const trace = db.prepare("SELECT type, data FROM run_events WHERE type = 'routing.decision'").get() as
      | { type: string; data: string }
      | undefined;
    expect(trace?.type).toBe('routing.decision');
    expect(JSON.parse(trace?.data ?? '{}')).toMatchObject({ mode: 'always', reason: 'always' });

    await app.close();
  });

  it('uses the lightweight relevance layer before invoking an agent', async () => {
    const asked: string[] = [];
    const respond: RespondFn = async ({ agentId }) => {
      asked.push(agentId);
      return { body: 'on it' };
    };
    const app = await buildApp({ db, respond });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const token = setup.json().token as string;
    const ownerId = setup.json().user.id as string;
    const agent = newAgent(ownerId, 'Release Helper', 'anthropic', 'triage deployment incidents and release failures');
    setAgentRoutingMode(db, agent.id, 'relevant', null, ownerId);
    const group = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Relevant', participants: [{ participantId: agent.id, participantType: 'agent' }] },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${group.json().id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'Please triage this deployment incident.' },
    });
    await settle();
    expect(asked).toEqual([agent.id]);

    asked.length = 0;
    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${group.json().id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'What should we order for lunch?' },
    });
    await settle();
    expect(asked).toEqual([]);

    await app.close();
  });

  it('reports a mentioned agent with no configured provider as a failed run', async () => {
    const app = await buildApp({ db });
    const { token, conversationId, betaId } = await setupGroupWithAgents(app, 'not-configured');

    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: '@Beta?', mentions: [{ targetId: betaId, targetType: 'agent' }] },
    });
    await settle();

    const events = failureEvents();
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe(betaId);
    expect(events[0].code).toBe('provider_not_configured');
    expect(events[0].error).toContain('Beta could not reply');

    await app.close();
  });

  it('refuses a message to a DM agent whose provider is not configured with 409', async () => {
    const app = await buildApp({ db });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const token = setup.json().token as string;
    const agent = newAgent(setup.json().user.id as string, 'Orphan', 'not-configured');
    const dm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: agent.id, participantType: 'agent' },
    });

    const post = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${dm.json().id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'hello?' },
    });
    expect(post.statusCode).toBe(409);
    expect(post.json().error).toBe('provider_not_configured');

    await app.close();
  });
});
