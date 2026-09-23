import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createProviderConfig } from '../providers/repository.js';

describe('runtime routes', () => {
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

  async function setupOwnerAndAgent(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const token = setup.json().token as string;
    const createAgent = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Assistant', modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' } },
    });
    return { token, agentId: createAgent.json().id as string };
  }

  it('creates and reads back a runtime binding', async () => {
    const app = await buildApp({ db });
    const { token, agentId } = await setupOwnerAndAgent(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime-bindings',
      headers: { authorization: `Bearer ${token}` },
      payload: { agentId, runtimeKind: 'native', workspacePath: '/workspaces/assistant' },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/runtime-bindings/${create.json().id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().workspacePath).toBe('/workspaces/assistant');

    await app.close();
  });

  it('creates and reads back a runtime session', async () => {
    const app = await buildApp({ db });
    const { token, agentId } = await setupOwnerAndAgent(app);

    const binding = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime-bindings',
      headers: { authorization: `Bearer ${token}` },
      payload: { agentId, runtimeKind: 'native', workspacePath: '/ws' },
    });
    const dm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: agentId, participantType: 'agent' },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime-sessions',
      headers: { authorization: `Bearer ${token}` },
      payload: { agentId, conversationId: dm.json().id, runtimeBindingId: binding.json().id },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/runtime-sessions/${create.json().id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().status).toBe('idle');

    await app.close();
  });

  it('invokes an agent and returns its persisted response message', async () => {
    const app = await buildApp({ db, respond: async ({ agentId }) => ({ body: `hi from ${agentId}` }) });
    const { token, agentId } = await setupOwnerAndAgent(app);
    const dm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: agentId, participantType: 'agent' },
    });

    const invoke = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/runs`,
      headers: { authorization: `Bearer ${token}` },
      payload: { conversationId: dm.json().id },
    });
    expect(invoke.statusCode).toBe(201);
    expect(invoke.json().message.body).toBe(`hi from ${agentId}`);

    await app.close();
  });

  it('rejects creating a runtime binding for an agent owned by another user with 403', async () => {
    const app = await buildApp({ db });
    const { agentId } = await setupOwnerAndAgent(app);

    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const bobToken = createSession(db, bob.id);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime-bindings',
      headers: { authorization: `Bearer ${bobToken}` },
      payload: { agentId, runtimeKind: 'native', workspacePath: '/workspaces/assistant' },
    });
    expect(create.statusCode).toBe(403);

    await app.close();
  });

  it('rejects invoking an agent run on a conversation the caller is not a participant of with 403', async () => {
    const app = await buildApp({ db });
    const { token, agentId } = await setupOwnerAndAgent(app);
    const dm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: agentId, participantType: 'agent' },
    });

    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const bobToken = createSession(db, bob.id);

    const invoke = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/runs`,
      headers: { authorization: `Bearer ${bobToken}` },
      payload: { conversationId: dm.json().id },
    });
    expect(invoke.statusCode).toBe(403);

    await app.close();
  });

  it('rejects running an agent in a conversation it is not a participant of with 403', async () => {
    const app = await buildApp({ db, respond: async () => ({ body: 'leaked' }) });
    const { agentId } = await setupOwnerAndAgent(app);

    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const bobToken = createSession(db, bob.id);
    const carol = createUser(db, { email: 'carol@example.com', displayName: 'Carol', passwordHash: 'x', role: 'member' });
    const bobAndCarol = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${bobToken}` },
      payload: { participantId: carol.id, participantType: 'user' },
    });

    const invoke = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/runs`,
      headers: { authorization: `Bearer ${bobToken}` },
      payload: { conversationId: bobAndCarol.json().id },
    });
    expect(invoke.statusCode).toBe(403);
    expect(invoke.json().error).toBe('agent_not_a_participant');

    await app.close();
  });
});
