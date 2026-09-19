import { openSqlite, type Database } from '../../src/db/driver.js';
import { buildApp } from '../../src/app.js';
import { runMigrations } from '../../src/db/migrate.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CrewlyClient } from '../../src/sdk/client.js';

describe('SDK end-to-end against a real running server', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let baseUrl: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db, respond: async () => ({ body: 'Test agent reply' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || address === null) throw new Error('expected AddressInfo');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('sets up an owner, creates an agent, sends a message over REST, and receives it live over WS', async () => {
    const client = new CrewlyClient({ baseUrl });

    await expect(client.health.get()).resolves.toEqual({ ok: true });

    const setup = await client.auth.setup({ email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' });
    client.setToken(setup.token);
    expect(setup.user.role).toBe('owner');

    await client.providers.create({ id: 'anthropic', kind: 'anthropic', apiKey: 'test-key' });

    const agent = await client.agents.create({
      name: 'Assistant',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
    });
    const conversation = await client.conversations.createDm({ participantId: agent.id, participantType: 'agent' });

    const ws = client.ws(WebSocket);
    const opened: Promise<void> = new Promise((resolve) => ws.onOpen(resolve));
    const received: Promise<void> = new Promise((resolve) => {
      ws.onEvent((event) => {
        if (event.type === 'message.created') resolve();
      });
    });
    ws.connect({ token: setup.token });
    await opened;

    const message = await client.messages.send(conversation.id, { body: 'hello from the SDK' });
    expect(message.body).toBe('hello from the SDK');

    await received;
    expect(ws.getLastSeq()).toBeGreaterThan(0);

    ws.close();
  });

  it('reconnects and replays events missed while disconnected, using getLastSeq', async () => {
    const client = new CrewlyClient({ baseUrl });
    const setup = await client.auth.setup({ email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' });
    client.setToken(setup.token);
    await client.providers.create({ id: 'anthropic', kind: 'anthropic', apiKey: 'test-key' });
    const agent = await client.agents.create({
      name: 'Assistant',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
    });
    const conversation = await client.conversations.createDm({ participantId: agent.id, participantType: 'agent' });

    const ws = client.ws(WebSocket);
    const opened: Promise<void> = new Promise((resolve) => ws.onOpen(resolve));
    const firstReceived: Promise<void> = new Promise((resolve) => {
      ws.onEvent((event) => {
        if (event.type === 'message.created') resolve();
      });
    });
    ws.connect({ token: setup.token });
    await opened;
    await client.messages.send(conversation.id, { body: 'first' });
    await firstReceived;
    const seqBeforeDisconnect = ws.getLastSeq()!;

    ws.close();
    await client.messages.send(conversation.id, { body: 'missed while disconnected' });

    const replayed: string[] = [];
    const replayedAll: Promise<void> = new Promise((resolve) => {
      ws.onEvent((event) => {
        if (event.type === 'message.created') {
          replayed.push((event.payload as { body: string }).body);
          if (replayed.includes('missed while disconnected')) resolve();
        }
      });
    });
    ws.reconnect();
    await replayedAll;

    expect(replayed).toContain('missed while disconnected');
    expect(ws.getLastSeq()).toBeGreaterThan(seqBeforeDisconnect);

    ws.close();
  });
});
