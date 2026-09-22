import { openSqlite, type Database } from '../src/db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createProviderConfig } from '../src/providers/repository.js';
import type { AgentTurnResult, RespondFn } from '../src/runtime/engine.js';

describe('runtime end-to-end: agent invocation, WS delivery, and max-hop protection', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let baseUrl: string;
  let loopingAgentId = '';

  const respond: RespondFn = async (input): Promise<AgentTurnResult> => {
    if (input.agentId === loopingAgentId) {
      return { body: 'still thinking, handing off to myself', handoffToAgentId: loopingAgentId };
    }
    return { body: 'Hello from the agent!' };
  };

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'sk-test' });
    app = await buildApp({ db, respond });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || address === null) throw new Error('expected AddressInfo');
    baseUrl = `127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  /** The first event of `type`; a run also announces itself starting and finishing. */
  function waitForMessage(socket: WebSocket, type = 'message.created'): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const onMessage = (data: WebSocket.RawData) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type !== type) return;
        socket.off('message', onMessage);
        resolve(event);
      };
      socket.on('message', onMessage);
    });
  }

  function waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve) => socket.once('open', () => resolve()));
  }

  it('invokes an agent via REST, persists its response, and delivers it live over WebSocket', async () => {
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
    const agentId = createAgent.json().id as string;

    const binding = await app.inject({
      method: 'POST',
      url: '/api/v1/runtime-bindings',
      headers: { authorization: `Bearer ${token}` },
      payload: { agentId, runtimeKind: 'native', workspacePath: '/workspaces/assistant' },
    });
    expect(binding.statusCode).toBe(201);

    const dm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: agentId, participantType: 'agent' },
    });
    expect(dm.statusCode).toBe(201);
    const conversationId = dm.json().id as string;

    const socket = new WebSocket(`ws://${baseUrl}/api/v1/ws?token=${token}`);
    await waitForOpen(socket);

    const messagePromise = waitForMessage(socket);
    const invoke = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/runs`,
      headers: { authorization: `Bearer ${token}` },
      payload: { conversationId },
    });
    expect(invoke.statusCode).toBe(201);
    expect(invoke.json().message.body).toBe('Hello from the agent!');

    const received = await messagePromise;
    expect(received.type).toBe('message.created');
    expect((received.payload as { body: string }).body).toBe('Hello from the agent!');
    socket.close();
  });

  it('stops an agent-to-agent handoff chain at the max hop count instead of looping forever', async () => {
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
      payload: { name: 'Looper', modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' } },
    });
    loopingAgentId = createAgent.json().id as string;

    const dm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: loopingAgentId, participantType: 'agent' },
    });
    const conversationId = dm.json().id as string;

    const invoke = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${loopingAgentId}/runs`,
      headers: { authorization: `Bearer ${token}` },
      payload: { conversationId },
    });
    expect(invoke.statusCode).toBe(201);

    const messages = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(messages.json()).toHaveLength(5);
  });
});
