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

  it('treats agents as colleagues: a name, a follow-up or a thread reaches them without an @', async () => {
    const asked: string[] = [];
    const respond: RespondFn = async ({ agentId }) => {
      asked.push(agentId);
      return { body: 'on it' };
    };
    const app = await buildApp({ db, respond });
    const { token, conversationId, alphaId, betaId } = await setupGroupWithAgents(app);
    const post = (body: string) => app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body },
    });

    // Said by name, the way a person addresses a colleague.
    await post('alpha, can you take the release notes?');
    await settle();
    expect(asked).toEqual([alphaId]);

    // Alpha spoke last, so a plain follow-up carries on with Alpha.
    await post('and the changelog too please');
    await settle();
    expect(asked).toEqual([alphaId, alphaId]);

    // Turning to someone else hands the conversation over.
    await post('Beta, what do you think?');
    await settle();
    expect(asked).toEqual([alphaId, alphaId, betaId]);

    // In a thread on Alpha's message, Alpha hears replies without an @.
    const messages = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    const alphaReply = (messages.json() as Array<{ id: string; authorId?: string; author?: string; authorType: string }>)
      .find((message) => message.authorType === 'agent' && (message.authorId ?? message.author) === alphaId);
    expect(alphaReply).toBeDefined();
    await app.inject({ method: 'POST', url: `/api/v1/messages/${alphaReply!.id}/thread`, headers: { authorization: `Bearer ${token}` } });
    const threadReply = await app.inject({
      method: 'POST',
      url: `/api/v1/threads/${alphaReply!.id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'can you expand on that?' },
    });
    expect(threadReply.statusCode).toBe(201);
    await settle();
    expect(asked).toEqual([alphaId, alphaId, betaId, alphaId]);

    await app.close();
  });

  it('lets the agent whose work a message is about answer it, even among several', async () => {
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
    const qa = newAgent(ownerId, 'Quinn', 'anthropic', 'QA Engineer\nYou keep the test suite green.');
    const writer = newAgent(ownerId, 'Wren', 'anthropic', 'Technical Writer\nYou write the docs.');
    const group = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Crew', participants: [
        { participantId: qa.id, participantType: 'agent' },
        { participantId: writer.id, participantType: 'agent' },
      ] },
    });
    const post = (body: string) => app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${group.json().id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body },
    });

    await post('good morning');
    await settle();
    expect(asked).toEqual([]);

    await post('how are the tests going?');
    await settle();
    expect(asked).toEqual([qa.id]);

    // A new topic that belongs to someone else hands it over, even right after Quinn spoke.
    await post('is the documentation for the release written yet?');
    await settle();
    expect(asked).toEqual([qa.id, writer.id]);

    await app.close();
  });

  async function setupCrew(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const token = setup.json().token as string;
    const ownerId = setup.json().user.id as string;
    const qa = newAgent(ownerId, 'Quinn', 'anthropic', 'QA Engineer\nYou keep the test suite green.');
    const writer = newAgent(ownerId, 'Wren', 'anthropic', 'Technical Writer\nYou write the docs.');
    const group = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Crew', participants: [
        { participantId: qa.id, participantType: 'agent' },
        { participantId: writer.id, participantType: 'agent' },
      ] },
    });
    const conversationId = group.json().id as string;
    const headers = { authorization: `Bearer ${token}` };
    return {
      qa, writer, conversationId,
      setMode: (replyMode: string) => app.inject({ method: 'PUT', url: `/api/v1/conversations/${conversationId}/reply-mode`, headers, payload: { replyMode } }),
      post: (body: string, mentions: Array<{ targetId: string; targetType: 'agent' | 'user' }> = []) =>
        app.inject({ method: 'POST', url: `/api/v1/conversations/${conversationId}/messages`, headers, payload: { body, mentions } }),
      agentMessages: () => db.prepare("SELECT author_id, body FROM messages WHERE conversation_id = ? AND author_type = 'agent' ORDER BY created_at, rowid").all(conversationId) as Array<{ author_id: string; body: string }>,
      headers,
    };
  }

  it('lets a conversation choose who answers, and remembers it', async () => {
    const app = await buildApp({ db, respond: async () => ({ body: 'ok' }) });
    const crew = await setupCrew(app);
    const url = `/api/v1/conversations/${crew.conversationId}/reply-mode`;
    expect((await app.inject({ method: 'GET', url, headers: crew.headers })).json()).toEqual({ replyMode: 'mentions' });
    expect((await crew.setMode('open')).json()).toEqual({ replyMode: 'open' });
    expect((await app.inject({ method: 'GET', url, headers: crew.headers })).json()).toEqual({ replyMode: 'open' });
    expect((await crew.setMode('everyone')).statusCode).toBe(400);
    await app.close();
  });

  it('lets a model pick who answers, and falls back to keywords when it cannot', async () => {
    const asked: string[] = [];
    const routed: Array<{ transcript: string[]; names: string[] }> = [];
    let answer: string[] | Error = [];
    const app = await buildApp({
      db,
      respond: async ({ agentId }) => { asked.push(agentId); return { body: 'on it' }; },
      replyRouter: async ({ transcript, candidates }) => {
        routed.push({ transcript, names: candidates.map((candidate) => candidate.name) });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    const crew = await setupCrew(app);
    await crew.setMode('model');

    // Keywords would pick nobody here; the model reads it as the writer's.
    answer = [crew.writer.id];
    await crew.post('can someone make sense of the changelog for the customers?');
    await settle();
    expect(asked).toEqual([crew.writer.id]);
    expect([...routed[0]!.names].sort()).toEqual(['Quinn', 'Wren']);
    expect(routed[0]!.transcript.at(-1)).toBe('Owner: can someone make sense of the changelog for the customers?');

    answer = [];
    await crew.post('good morning everyone');
    await settle();
    expect(asked).toEqual([crew.writer.id]);

    // Addressed by @: nobody needs to decide.
    await crew.post('run the suite please', [{ targetId: crew.qa.id, targetType: 'agent' }]);
    await settle();
    expect(routed).toHaveLength(2);
    expect(asked).toEqual([crew.writer.id, crew.qa.id]);

    answer = new Error('provider down');
    await crew.post('are the docs for the release written yet?');
    await settle();
    expect(asked).toEqual([crew.writer.id, crew.qa.id, crew.writer.id]);
    await app.close();
  });

  it('in an open room every free agent hears it and only those with something to add reply', async () => {
    const asked: Array<{ agentId: string; optional: boolean }> = [];
    let finishLongRun: () => void = () => undefined;
    const app = await buildApp({
      db,
      respond: async ({ agentId, optionalReply, recentMessages }) => {
        asked.push({ agentId, optional: Boolean(optionalReply) });
        if (recentMessages.at(-1)?.body === 'start the long regression run') {
          await new Promise<void>((resolve) => { finishLongRun = resolve; });
          return { body: 'regression run finished' };
        }
        return { body: agentId === crewIds.qa ? 'tests are green' : 'NO_REPLY' };
      },
    });
    const crew = await setupCrew(app);
    const crewIds = { qa: crew.qa.id };
    await crew.setMode('open');

    await crew.post('how is everything going?');
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked).toEqual(expect.arrayContaining([{ agentId: crew.qa.id, optional: true }, { agentId: crew.writer.id, optional: true }]));
    // The writer heard it and chose to stay quiet: nothing posted for it.
    expect(crew.agentMessages().map((row) => row.body)).toEqual(['tests are green']);

    // An agent at work is left to it; the message still reaches the others.
    await crew.post('start the long regression run', [{ targetId: crew.qa.id, targetType: 'agent' }]);
    await settle();
    asked.length = 0;
    await crew.post('anyone free for a quick question?');
    await settle();
    expect(asked).toEqual([{ agentId: crew.writer.id, optional: true }]);
    finishLongRun();
    await settle();
    expect(crew.agentMessages().map((row) => row.body)).toEqual(['tests are green', 'regression run finished']);
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
      payload: { body: 'What should we order for lunch?' },
    });
    await settle();
    expect(asked).toEqual([]);

    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${group.json().id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'Please triage this deployment incident.' },
    });
    await settle();
    expect(asked).toEqual([agent.id]);

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
