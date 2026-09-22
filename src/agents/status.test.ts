import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createApproval } from '../approvals/repository.js';
import { createSession } from '../auth/session.js';
import { createConversation } from '../conversations/repository.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createProviderConfig } from '../providers/repository.js';
import { createRuntimeBinding } from '../runtime/bindings.js';
import { runAgentTurn, type AgentTurnResult } from '../runtime/engine.js';
import { AgentRunQueue } from '../runtime/queue.js';
import { createAgentRun, failAgentRun, completeAgentRun } from '../runtime/runs.js';
import { createUser } from '../users/repository.js';
import { ConnectionHub } from '../ws/hub.js';
import { createAgent, getAgent, setAgentAvailability } from './repository.js';
import { AgentStatusBroadcaster, canAutoInvoke, computeAgentStatus } from './status.js';

function fresh(providerKind: 'anthropic' | 'claude-subscription' = 'anthropic') {
  const db = openSqlite(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const owner = createUser(db, { email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
  createProviderConfig(db, { id: 'p', kind: providerKind, apiKey: providerKind === 'anthropic' ? 'sk' : null });
  const agent = createAgent(db, {
    ownerUserId: owner.id,
    name: 'Worker',
    personality: '',
    modelPolicy: { defaultProviderId: 'p', defaultModel: 'claude-haiku-4-5' },
    permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
  });
  const conversation = createConversation(db, {
    kind: 'dm',
    name: null,
    participants: [
      { participantId: owner.id, participantType: 'user' },
      { participantId: agent.id, participantType: 'agent' },
    ],
  });
  return { db, owner, agent, conversation };
}

describe('computeAgentStatus', () => {
  let db: Database;
  afterEach(() => db.close());

  it('is idle and ready when it can work and has not lately', () => {
    const setup = fresh();
    db = setup.db;
    expect(computeAgentStatus(db, setup.agent)).toEqual({
      agentId: setup.agent.id,
      presence: 'idle',
      execution: 'ready',
      reason: null,
      availability: 'auto',
      activeRunId: null,
      lastActiveAt: null,
    });
  });

  it('is online and working while a run is in progress, and names the run', () => {
    const setup = fresh();
    db = setup.db;
    createAgentRun(db, { runId: 'r1', rootRunId: 'r1', causationId: null, hopCount: 0, agentId: setup.agent.id, conversationId: setup.conversation.id });
    expect(computeAgentStatus(db, setup.agent)).toMatchObject({ presence: 'online', execution: 'working', activeRunId: 'r1' });
  });

  it('is waiting for approval when a run is blocked on one', () => {
    const setup = fresh();
    db = setup.db;
    createAgentRun(db, { runId: 'r1', rootRunId: 'r1', causationId: null, hopCount: 0, agentId: setup.agent.id, conversationId: setup.conversation.id });
    createApproval(db, { runId: 'r1', agentId: setup.agent.id, action: 'shell', details: { command: 'rm -rf build' } });
    expect(computeAgentStatus(db, setup.agent)).toMatchObject({ execution: 'waiting_approval', reason: 'Waiting for approval' });
  });

  it('is in error after a failed run, and online because it was just active', () => {
    const setup = fresh();
    db = setup.db;
    createAgentRun(db, { runId: 'r1', rootRunId: 'r1', causationId: null, hopCount: 0, agentId: setup.agent.id, conversationId: setup.conversation.id });
    failAgentRun(db, 'r1', { code: 'provider_unavailable', message: 'down' });
    expect(computeAgentStatus(db, setup.agent)).toMatchObject({
      presence: 'online', execution: 'error', reason: 'Last run failed: provider_unavailable',
    });
  });

  it('recovers from an error once a later run succeeds', () => {
    const setup = fresh();
    db = setup.db;
    createAgentRun(db, { runId: 'r1', rootRunId: 'r1', causationId: null, hopCount: 0, agentId: setup.agent.id, conversationId: setup.conversation.id });
    failAgentRun(db, 'r1', { code: 'provider_unavailable', message: 'down' });
    createAgentRun(db, { runId: 'r2', rootRunId: 'r2', causationId: null, hopCount: 0, agentId: setup.agent.id, conversationId: setup.conversation.id });
    completeAgentRun(db, 'r2', null);
    expect(computeAgentStatus(db, setup.agent).execution).toBe('ready');
  });

  it('is offline, and says so plainly, when its Claude device is not connected', () => {
    const setup = fresh('claude-subscription');
    db = setup.db;
    expect(computeAgentStatus(db, setup.agent)).toMatchObject({
      presence: 'offline', execution: 'provider_unavailable', reason: 'Claude device offline',
    });
  });

  it('is offline when its provider has been removed', () => {
    const setup = fresh();
    db = setup.db;
    db.prepare('DELETE FROM provider_configs').run();
    expect(computeAgentStatus(db, setup.agent)).toMatchObject({
      presence: 'offline', execution: 'provider_unavailable', reason: 'No model provider is configured',
    });
  });

  it('is offline when the coding runtime it is bound to is on no connected device', () => {
    const setup = fresh();
    db = setup.db;
    createRuntimeBinding(db, { agentId: setup.agent.id, runtimeKind: 'claude-code', workspacePath: '/src/app' });
    expect(computeAgentStatus(db, setup.agent)).toMatchObject({
      presence: 'offline', execution: 'runtime_unavailable', reason: 'No paired device',
    });
  });

  it('keeps presence and execution apart: Do Not Disturb, still ready', () => {
    const setup = fresh();
    db = setup.db;
    const agent = setAgentAvailability(db, setup.agent.id, 'dnd')!;
    const status = computeAgentStatus(db, agent);
    expect(status).toMatchObject({ presence: 'dnd', execution: 'ready', availability: 'dnd' });
    expect(canAutoInvoke(status)).toBe(false);
  });
});

describe('AgentStatusBroadcaster', () => {
  it('publishes a status when it changes, and not otherwise', () => {
    const { db, agent, conversation } = fresh();
    const hub = new ConnectionHub(db);
    const broadcaster = new AgentStatusBroadcaster(db, hub, () => ({}));
    const published = () => db.prepare("SELECT payload FROM event_log WHERE topic = 'agents'").all().length;

    broadcaster.refresh();
    broadcaster.refresh();
    expect(published()).toBe(1);

    createAgentRun(db, { runId: 'r1', rootRunId: 'r1', causationId: null, hopCount: 0, agentId: agent.id, conversationId: conversation.id });
    expect(broadcaster.refresh(agent.id)).toMatchObject([{ execution: 'working' }]);
    expect(published()).toBe(2);
    db.close();
  });
});

describe('one run at a time per agent', () => {
  it('queues a second message behind the first, and says so while it waits', async () => {
    const { db, owner, agent, conversation } = fresh();
    const hub = new ConnectionHub(db);
    const queue = new AgentRunQueue();
    const releases: Array<(result: AgentTurnResult) => void> = [];
    const respond = () => new Promise<AgentTurnResult>((resolve) => releases.push(resolve));
    const statuses: string[] = [];
    const deps = {
      db, hub, respond, queue,
      onAgentChange: () => statuses.push(computeAgentStatus(db, getAgent(db, agent.id)!).execution),
    };

    const first = runAgentTurn(deps, { agentId: agent.id, conversationId: conversation.id });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = runAgentTurn(deps, { agentId: agent.id, conversationId: conversation.id });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Only the first is talking to a model; the second is recorded as queued.
    expect(releases).toHaveLength(1);
    const queued = db.prepare("SELECT run_id FROM agent_runs WHERE status = 'queued'").all();
    expect(queued).toHaveLength(1);

    releases[0]!({ body: 'one' });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(releases).toHaveLength(2);
    releases[1]!({ body: 'two' });
    const outcome = await second;

    expect(outcome.message.body).toBe('two');
    expect(statuses).toContain('queued');
    expect(statuses.at(-1)).toBe('ready');
    expect(owner).toBeDefined();
    db.close();
  });
});

describe('status routes', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    ({ db } = fresh());
    app = await buildApp({ db });
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('lets the owner put their agent on Do Not Disturb, and nobody else', async () => {
    const agent = db.prepare('SELECT id, owner_user_id FROM agents').get() as { id: string; owner_user_id: string };
    const member = createUser(db, { email: 'm@example.com', displayName: 'M', passwordHash: 'x', role: 'member' });

    const denied = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${agent.id}/availability`,
      headers: { authorization: `Bearer ${createSession(db, member.id)}` }, payload: { availability: 'dnd' },
    });
    expect(denied.statusCode).toBe(403);

    const owner = createSession(db, agent.owner_user_id);
    const set = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${agent.id}/availability`,
      headers: { authorization: `Bearer ${owner}` }, payload: { availability: 'dnd' },
    });
    expect(set.json()).toMatchObject({ presence: 'dnd', availability: 'dnd' });

    const all = await app.inject({ method: 'GET', url: '/api/v1/agents/status', headers: { authorization: `Bearer ${owner}` } });
    expect(all.json().statuses).toMatchObject([{ agentId: agent.id, presence: 'dnd' }]);
    // A reconnecting client can replay the change from the event log.
    expect(db.prepare("SELECT type FROM event_log WHERE topic = 'agents'").pluck().all()).toContain('agent.status');
  });
});
