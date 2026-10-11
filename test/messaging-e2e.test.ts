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

  it('opens bounded search context only for users allowed to read that conversation', async () => {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { email: 'context-owner@example.com', displayName: 'Owner', password: 'super-secret-1' } });
    const headers = { authorization: `Bearer ${setup.json().token}` };
    const member = createUser(db, { email: 'context-member@example.com', displayName: 'Member', passwordHash: 'x', role: 'member' });
    const outsider = createUser(db, { email: 'context-outsider@example.com', displayName: 'Outsider', passwordHash: 'x', role: 'member' });
    const conversation = await app.inject({ method: 'POST', url: '/api/v1/conversations', headers, payload: { participantId: member.id, participantType: 'user' } });
    const post = await app.inject({ method: 'POST', url: `/api/v1/conversations/${conversation.json().id}/messages`, headers, payload: { body: 'Private searchable text' } });
    const url = `/api/v1/messages/${post.json().id}/context`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${createSession(db, outsider.id)}` } })).statusCode).toBe(403);
    const allowed = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${createSession(db, member.id)}` } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().messages.map((message: { id: string }) => message.id)).toEqual([post.json().id]);
  });

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
  it('delivers thread replies and resolved status live, with accurate root summaries', async () => {
    const alice = createUser(db, { email: 'thread-alice@example.com', displayName: 'Alice', passwordHash: 'x', role: 'owner' });
    const bob = createUser(db, { email: 'thread-bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const aliceHeaders = { authorization: `Bearer ${createSession(db, alice.id)}` };
    const bobToken = createSession(db, bob.id);
    const group = await app.inject({ method: 'POST', url: '/api/v1/conversations/group', headers: aliceHeaders,
      payload: { name: 'Threads', participants: [{ participantId: bob.id, participantType: 'user' }] } });
    const conversationId = group.json().id;
    const root = await app.inject({ method: 'POST', url: `/api/v1/conversations/${conversationId}/messages`, headers: aliceHeaders, payload: { body: 'Discuss here' } });
    const rootId = root.json().id;
    expect((await app.inject({ method: 'POST', url: `/api/v1/messages/${rootId}/thread`, headers: aliceHeaders })).statusCode).toBe(201);
    const stream = connectWs(bobToken);
    await stream.ready;
    try {
      const reply = await app.inject({ method: 'POST', url: `/api/v1/threads/${rootId}/messages`, headers: aliceHeaders, payload: { body: 'A live reply' } });
      expect(reply.statusCode).toBe(201);
      expect(await stream.next()).toMatchObject({ type: 'thread.message.created', payload: { rootMessageId: rootId, message: { body: 'A live reply' } } });
      expect(await stream.next()).toMatchObject({ type: 'thread.updated', payload: { id: rootId, thread: { replyCount: 1, status: 'open' } } });
      const resolved = await app.inject({ method: 'PATCH', url: `/api/v1/threads/${rootId}`, headers: aliceHeaders, payload: { status: 'resolved' } });
      expect(resolved.statusCode).toBe(200);
      expect(await stream.next()).toMatchObject({ type: 'thread.updated', payload: { id: rootId, thread: { replyCount: 1, status: 'resolved' } } });
      const timeline = await app.inject({ method: 'GET', url: `/api/v1/conversations/${conversationId}/messages`, headers: aliceHeaders });
      expect(timeline.json()).toHaveLength(1);
      expect(timeline.json()[0].thread).toMatchObject({ status: 'resolved', replyCount: 1 });
    } finally { stream.socket.close(); }
  });

});
