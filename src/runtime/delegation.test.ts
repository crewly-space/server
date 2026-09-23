import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAgent, setAgentAvailability } from '../agents/repository.js';
import { createSession } from '../auth/session.js';
import { createConversation } from '../conversations/repository.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { AiGateway } from '../gateway/gateway.js';
import { createProviderConfig } from '../providers/repository.js';
import { createUser } from '../users/repository.js';
import { setDelegates } from './delegation.js';

interface SentBody {
  system?: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string }>;
}

const text = (value: string) =>
  new Response(JSON.stringify({ content: [{ type: 'text', text: value }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } }));
const delegate = (agent: string, task: string, id = 'd1') =>
  new Response(JSON.stringify({
    content: [{ type: 'tool_use', id, name: 'delegate_to_agent', input: { agent, task } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 10 },
  }));

describe('agent-to-agent delegation', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let replies: Response[];
  let sent: SentBody[];
  let ownerId: string;
  let token: string;
  let lead: string;
  let researcher: string;
  let conversationId: string;

  async function boot(maxDelegationDepth?: number) {
    const gateway = new AiGateway({
      db,
      sleep: async () => {},
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        const next = replies.shift();
        if (!next) throw new Error('no reply scripted');
        return next;
      }) as unknown as typeof fetch,
    });
    app = await buildApp({ db, gateway, maxDelegationDepth });
  }

  const newAgent = (name: string, personality = '') =>
    createAgent(db, {
      ownerUserId: ownerId,
      name,
      personality,
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-haiku-4-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    }).id;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    replies = [];
    sent = [];
    ownerId = createUser(db, { email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' }).id;
    token = createSession(db, ownerId);
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'sk' });
    lead = newAgent('Lead');
    researcher = newAgent('Researcher', 'Finds facts.');
    conversationId = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: ownerId, participantType: 'user' },
        { participantId: lead, participantType: 'agent' },
      ],
    }).id;
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  async function ask(body: string) {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` }, payload: { body },
    });
    expect(response.statusCode).toBe(201);
    for (let i = 0; i < 200; i += 1) {
      const run = await app.inject({ method: 'GET', url: `/api/v1/messages/${response.json().id}/run`, headers: { authorization: `Bearer ${token}` } });
      if (run.statusCode === 200 && ['completed', 'failed'].includes(run.json().run.status)) return run.json();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('run never finished');
  }

  const toolResult = (body: SentBody) => {
    const last = body.messages.at(-1)!;
    const block = (last.content as Array<{ type: string; content: string }>)[0]!;
    expect(block.type).toBe('tool_result');
    return JSON.parse(block.content) as Record<string, unknown>;
  };

  it('hands a subtask to another agent and brings its answer back as a structured result', async () => {
    setDelegates(db, lead, [researcher]);
    await boot();
    replies.push(delegate('Researcher', 'What is the answer to X?'), text('X is 42.'), text('The answer is 42.'));

    const trace = await ask('my private question about X');

    // The researcher saw the task and nothing of the conversation.
    expect(JSON.stringify(sent[1]!.messages)).toContain('What is the answer to X?');
    expect(JSON.stringify(sent[1])).not.toContain('my private question');
    expect(toolResult(sent[2]!)).toMatchObject({ status: 'completed', agent: 'Researcher', answer: 'X is 42.' });

    // Only the lead speaks in the conversation.
    const messages = await app.inject({ method: 'GET', url: `/api/v1/conversations/${conversationId}/messages`, headers: { authorization: `Bearer ${token}` } });
    expect(messages.json().map((m: { body: string }) => m.body)).toEqual(['my private question about X', 'The answer is 42.']);

    // The chain: root run by the lead, one child by the researcher, a hop deeper, caused by the root.
    expect(trace.tree).toMatchObject([
      { agentName: 'Lead', hopCount: 0, causationId: null, status: 'completed' },
      { agentName: 'Researcher', hopCount: 1, causationId: trace.run.runId, status: 'completed', trigger: 'delegation' },
    ]);
    // Spend is attributed to the agent that did it, and to the workflow it was for.
    const calls = db.prepare('SELECT agent_id, root_run_id FROM provider_calls ORDER BY rowid').all() as Array<{ agent_id: string; root_run_id: string }>;
    expect(calls.map((c) => c.agent_id)).toEqual([lead, researcher, lead]);
    expect(new Set(calls.map((c) => c.root_run_id))).toEqual(new Set([trace.run.runId]));
    expect(trace.treeCostMicros).toBeGreaterThan(trace.summary.costMicros);
    expect(trace.events.map((e: { type: string }) => e.type)).toContain('delegation.completed');
  });

  it('offers no delegation tool to an agent with nobody to delegate to', async () => {
    await boot();
    replies.push(text('Hi.'));
    await ask('hello');
    expect(sent[0]!.tools).toBeUndefined();
  });

  it('refuses a delegation back up the chain, so agents cannot loop', async () => {
    setDelegates(db, lead, [researcher]);
    setDelegates(db, researcher, [lead]);
    await boot();
    replies.push(
      delegate('Researcher', 'Look into it'),
      delegate('Lead', 'You look into it', 'd2'),
      text('I could not hand it back, so: nothing found.'),
      text('Nothing found.'),
    );
    await ask('go');
    expect(toolResult(sent[2]!)).toMatchObject({ status: 'refused', error: 'Lead is already working on this chain; delegating back would loop.' });
  });

  it('stops offering delegation at the depth limit', async () => {
    const third = newAgent('Third');
    setDelegates(db, lead, [researcher]);
    setDelegates(db, researcher, [third]);
    await boot(1);
    replies.push(delegate('Researcher', 'dig'), text('dug'), text('done'));
    await ask('go');
    expect(sent[0]!.tools?.map((t) => t.name)).toEqual(['delegate_to_agent']);
    // The researcher is one hop down, which is the limit: no tool for it.
    expect(sent[1]!.tools).toBeUndefined();
  });

  it('will not wake an agent that is on Do Not Disturb', async () => {
    setDelegates(db, lead, [researcher]);
    setAgentAvailability(db, researcher, 'dnd');
    await boot();
    replies.push(delegate('Researcher', 'dig'), text('I will do it myself.'));
    await ask('go');
    expect(toolResult(sent[1]!)).toMatchObject({ status: 'refused', error: 'Researcher is unavailable (dnd).' });
  });

  it('will not bring in an agent the channel has blocked', async () => {
    setDelegates(db, lead, [researcher]);
    await boot();
    const created = await app.inject({
      method: 'POST', url: '/api/v1/channels', headers: { authorization: `Bearer ${token}` },
      payload: { name: 'research', members: [{ participantId: lead, participantType: 'agent' }] },
    });
    conversationId = created.json().id;
    await app.inject({ method: 'PUT', url: `/api/v1/channels/${conversationId}/agents/${researcher}/block`, headers: { authorization: `Bearer ${token}` } });
    replies.push(delegate('Researcher', 'dig'), text('I will do it myself.'));
    const response = await app.inject({
      method: 'POST', url: `/api/v1/conversations/${conversationId}/messages`, headers: { authorization: `Bearer ${token}` },
      payload: { body: '@Lead go', mentions: [{ targetId: lead, targetType: 'agent' }] },
    });
    expect(response.statusCode).toBe(201);
    for (let i = 0; i < 200 && sent.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(toolResult(sent[1]!)).toMatchObject({ status: 'refused', error: 'Researcher is blocked in this channel.' });
  });

  it('tells the delegating agent when the delegate failed, and lets it carry on', async () => {
    setDelegates(db, lead, [researcher]);
    await boot();
    replies.push(delegate('Researcher', 'dig'), new Response('{}', { status: 401 }), text('The researcher is unavailable.'));
    const trace = await ask('go');
    expect(toolResult(sent[2]!)).toMatchObject({ status: 'failed', agent: 'Researcher', error: { code: 'provider_auth_failed' } });
    expect(trace.run.status).toBe('completed');
    expect(trace.tree[1]).toMatchObject({ agentName: 'Researcher', status: 'failed' });
  });

  it('lets only the agent’s owner or an admin choose its delegates', async () => {
    await boot();
    const member = createUser(db, { email: 'm@example.com', displayName: 'M', passwordHash: 'x', role: 'member' });
    const denied = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${lead}/delegates`,
      headers: { authorization: `Bearer ${createSession(db, member.id)}` }, payload: { agentIds: [researcher] },
    });
    expect(denied.statusCode).toBe(403);
    const self = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${lead}/delegates`,
      headers: { authorization: `Bearer ${token}` }, payload: { agentIds: [lead] },
    });
    expect(self.statusCode).toBe(400);
    const set = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${lead}/delegates`,
      headers: { authorization: `Bearer ${token}` }, payload: { agentIds: [researcher] },
    });
    expect(set.json()).toEqual({ delegates: [{ agentId: researcher, name: 'Researcher' }] });
  });
});
