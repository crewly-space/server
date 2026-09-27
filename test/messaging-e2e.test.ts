import { openSqlite, type Database } from '../src/db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createSession } from '../src/auth/session.js';
import { createUser } from '../src/users/repository.js';

describe('messaging end-to-end: dm/group creation, persistence, WS delivery, reconnect/replay', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let baseUrl: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || address === null) throw new Error('expected AddressInfo');
    baseUrl = `127.0.0.1:${address.port}`;
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

  it('proves the full messaging path: group creation, message persistence, live WS delivery, and reconnect/replay across a disconnect', async () => {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'alice@example.com', displayName: 'Alice', password: 'super-secret-1' },
    });
    const aliceToken = setup.json().token as string;
    const aliceId = setup.json().user.id as string;

    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const bobToken = createSession(db, bob.id);

    const group = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { name: 'Launch planning', participants: [{ participantId: bob.id, participantType: 'user' }] },
    });
    expect(group.statusCode).toBe(201);
    const conversationId = group.json().id as string;

    const { socket: bobSocket, next: bobNext, ready: bobReady } = connectWs(bobToken);
    await bobReady;

    const firstMessagePromise = bobNext();
    const firstPost = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { body: 'kickoff is monday' },
    });
    expect(firstPost.statusCode).toBe(201);
    const firstReceived = await firstMessagePromise;
    expect(firstReceived.type).toBe('message.created');
    expect((firstReceived.payload as { body: string }).body).toBe('kickoff is monday');
    const lastSeenSeq = firstReceived.seq as number;

    bobSocket.close();
    await new Promise((resolve) => bobSocket.once('close', resolve));

    const secondPost = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { body: 'moved to tuesday, sent while bob was offline' },
    });
    expect(secondPost.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(list.json()).toHaveLength(2);

    const { socket: bobReconnect, next: reconnectNext, ready: reconnectReady } = connectWs(bobToken, lastSeenSeq);
    await reconnectReady;
    const replayed = await reconnectNext();
    expect(replayed.type).toBe('message.created');
    expect((replayed.payload as { body: string }).body).toBe('moved to tuesday, sent while bob was offline');
    bobReconnect.close();
  });
});
