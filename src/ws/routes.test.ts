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

  /** Opens a socket, authenticates by first message, and queues what arrives after. */
  function connectWs(authToken: string, sinceSeq?: number) {
    const socket = new WebSocket(`ws://${baseUrl}/api/v1/ws`);
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<(message: Record<string, unknown>) => void> = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message); else queue.push(message);
    });
    const next = (): Promise<Record<string, unknown>> =>
      queue.length ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve));
    socket.once('open', () => socket.send(JSON.stringify({ type: 'authenticate', token: authToken, ...(sinceSeq === undefined ? {} : { sinceSeq }) })));
    const ready = next().then((message) => {
      if (message.type !== 'authenticated') throw new Error(`expected authenticated, got ${String(message.type)}`);
    });
    return { socket, next, ready };
  }

  it('delivers a live event published after the socket connects', async () => {
    const { socket, next, ready } = connectWs(token);
    await ready;

    const messagePromise = next();
    app.hub.publish(`user:${userId}`, 'user.updated', { hello: 'world' });
    const received = await messagePromise;

    expect(received.type).toBe('user.updated');
    expect(received.payload).toEqual({ hello: 'world' });
    socket.close();
  });

  it('replays events published while disconnected when reconnecting with sinceSeq', async () => {
    const { socket: firstSocket, ready: firstReady } = connectWs(token);
    await firstReady;
    firstSocket.close();
    await new Promise((resolve) => firstSocket.once('close', resolve));

    const missedWhileDisconnected = app.hub.publish(`user:${userId}`, 'user.updated', { n: 1 });

    const { socket: secondSocket, next: secondNext, ready: secondReady } = connectWs(token, 0);
    await secondReady;
    const replayed = await secondNext();

    expect(replayed.seq).toBe(missedWhileDisconnected.seq);
    expect(replayed.payload).toEqual({ n: 1 });
    secondSocket.close();
  });

  it('never reads a token from the query string', async () => {
    const socket = new WebSocket(`ws://${baseUrl}/api/v1/ws?token=${token}`);
    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: 'subscribe' }));
    const closeCode = await new Promise<number>((resolve) => socket.once('close', resolve));
    expect(closeCode).toBe(4001);
  });

  it('closes the connection with 4001 for an invalid token', async () => {
    const { socket } = connectWs('not-a-real-token');
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

    const { socket, next, ready } = connectWs(token);
    await ready;

    const messagePromise = next();
    app.hub.publish(`conversation:${conversation.id}`, 'message.created', { body: 'hi' });
    const received = await messagePromise;

    expect(received.topic).toBe(`conversation:${conversation.id}`);
    socket.close();
  });
});
