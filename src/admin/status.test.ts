import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createAgent } from '../agents/repository.js';
import { createConversation } from '../conversations/repository.js';
import { createMessage } from '../messages/repository.js';
import { enqueueJob } from '../jobs/repository.js';

describe('what the dashboard can say about a running server', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: string;
  let ownerId: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    owner = setup.json().token;
    ownerId = setup.json().user.id;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  it('reports what the server is running and how much of it there is', async () => {
    const agent = createAgent(db, {
      ownerUserId: ownerId,
      name: 'Echo',
      personality: 'Helpful',
      modelPolicy: { defaultProviderId: 'openai-1', defaultModel: 'gpt-4o-mini' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    const conversation = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: ownerId, participantType: 'user' },
        { participantId: agent.id, participantType: 'agent' },
      ],
    });
    createMessage(db, {
      conversationId: conversation.id,
      authorId: ownerId,
      authorType: 'user',
      body: 'Hello',
      mentions: [],
      replyToMessageId: null,
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/server/status', headers: as(owner) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: expect.any(String),
      uptimeSeconds: expect.any(Number),
      usage: { users: 1, agents: 1, conversations: 1, messages: 1 },
      jobs: { pending: 0, failed: 0 },
    });
  });

  it('counts the work waiting and the work that failed', async () => {
    enqueueJob(db, { type: 'summarize', payload: {} });
    db.prepare("UPDATE jobs SET status = 'failed', last_error = 'provider down'").run();
    enqueueJob(db, { type: 'summarize', payload: { conversationId: 'c2' } });

    const status = await app.inject({ method: 'GET', url: '/api/v1/server/status', headers: as(owner) });
    expect(status.json().jobs).toEqual({ pending: 1, failed: 1 });
  });

  it('shows recent failures, newest first, so a problem can be read rather than guessed', async () => {
    enqueueJob(db, { type: 'summarize', payload: { conversationId: 'c1' } });
    db.prepare("UPDATE jobs SET status = 'failed', last_error = 'provider down'").run();

    const logs = await app.inject({ method: 'GET', url: '/api/v1/server/logs', headers: as(owner) });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().entries[0]).toMatchObject({
      kind: 'job_failed',
      detail: 'provider down',
      subject: 'summarize',
    });
  });

  it('keeps all of it to the people who run the server', async () => {
    const invited = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: as(owner),
      payload: { email: 'member@example.com', displayName: 'Member', password: 'member-secret-1' },
    });
    expect(invited.statusCode).toBe(201);
    const member = (await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'member@example.com', password: 'member-secret-1' },
    })).json().token;

    expect((await app.inject({ method: 'GET', url: '/api/v1/server/status', headers: as(member) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/server/logs', headers: as(member) })).statusCode).toBe(403);
  });

  it('says nothing at all to a stranger', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/server/status' })).statusCode).toBe(401);
  });
});
