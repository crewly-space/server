import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createConversation } from '../conversations/repository.js';

describe('WebSocket delivery and reconnect/replay', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let baseUrl: string;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || address === null) throw new Error('expected AddressInfo');
    baseUrl = `127.0.0.1:${address.port}`;

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    token = setup.json().token;
    userId = setup.json().user.id;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
  }

  function waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve) => socket.once('open', () => resolve()));
  }

  it('delivers a live event published after the socket connects', async () => {
    const socket = new WebSocket(`ws://${baseUrl}/api/v1/ws?token=${token}`);
    await waitForOpen(socket);

    const messagePromise = waitForMessage(socket);
    app.hub.publish(`user:${userId}`, 'user.updated', { hello: 'world' });
    const received = await messagePromise;

    expect(received.type).toBe('user.updated');
    expect(received.payload).toEqual({ hello: 'world' });
    socket.close();
  });

  it('replays events published while disconnected when reconnecting with sinceSeq', async () => {
    const firstSocket = new WebSocket(`ws://${baseUrl}/api/v1/ws?token=${token}`);
    await waitForOpen(firstSocket);
    firstSocket.close();
    await new Promise((resolve) => firstSocket.once('close', resolve));

    const missedWhileDisconnected = app.hub.publish(`user:${userId}`, 'user.updated', { n: 1 });

    const secondSocket = new WebSocket(`ws://${baseUrl}/api/v1/ws?token=${token}&sinceSeq=0`);
    const replayed = await waitForMessage(secondSocket);

    expect(replayed.seq).toBe(missedWhileDisconnected.seq);
    expect(replayed.payload).toEqual({ n: 1 });
    secondSocket.close();
  });

  it('closes the connection with 4001 for an invalid token', async () => {
    const socket = new WebSocket(`ws://${baseUrl}/api/v1/ws?token=not-a-real-token`);
    const closeCode = await new Promise<number>((resolve) => socket.once('close', resolve));
    expect(closeCode).toBe(4001);
  });

  it('subscribes a connecting client to its conversation topics, not just its user topic', async () => {
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const conversation = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: userId, participantType: 'user' },
        { participantId: bob.id, participantType: 'user' },
      ],
    });

    const socket = new WebSocket(`ws://${baseUrl}/api/v1/ws?token=${token}`);
    await waitForOpen(socket);

    const messagePromise = waitForMessage(socket);
    app.hub.publish(`conversation:${conversation.id}`, 'message.created', { body: 'hi' });
    const received = await messagePromise;

    expect(received.topic).toBe(`conversation:${conversation.id}`);
    socket.close();
  });
});
