import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';

describe('message routes', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
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
});
