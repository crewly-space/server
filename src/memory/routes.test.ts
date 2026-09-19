import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { runMigrations } from '../db/migrate.js';
import { updateConversationSummary } from './summary.js';
import { createUser } from '../users/repository.js';
import { createProviderConfig } from '../providers/repository.js';

describe('memory fact routes', () => {
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

  async function setupOwnerWithAgent(app: Awaited<ReturnType<typeof buildApp>>) {
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

  it('creates a memory fact for the owning user and returns 201', async () => {
    const app = await buildApp({ db });
    const { token, agentId } = await setupOwnerWithAgent(app);

    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/memory-facts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'Prefers concise answers.' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().content).toBe('Prefers concise answers.');
    expect(create.json().source).toBe('manual');

    await app.close();
  });

  it('returns 200 (not 201) when the content deduplicates into an existing fact', async () => {
    const app = await buildApp({ db });
    const { token, agentId } = await setupOwnerWithAgent(app);

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/memory-facts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'Likes dark mode.' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/memory-facts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: '  Likes DARK mode.  ' },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    await app.close();
  });

  it('lists memory facts for the agent', async () => {
    const app = await buildApp({ db });
    const { token, agentId } = await setupOwnerWithAgent(app);
    await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/memory-facts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'One.' },
    });

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agentId}/memory-facts`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    await app.close();
  });

  it('updates a memory fact', async () => {
    const app = await buildApp({ db });
    const { token, agentId } = await setupOwnerWithAgent(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/memory-facts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'Original.' },
    });
    const factId = create.json().id as string;

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/${agentId}/memory-facts/${factId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'Revised.' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().content).toBe('Revised.');

    await app.close();
  });

  it('deletes a memory fact', async () => {
    const app = await buildApp({ db });
    const { token, agentId } = await setupOwnerWithAgent(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/memory-facts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'Temporary.' },
    });
    const factId = create.json().id as string;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${agentId}/memory-facts/${factId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agentId}/memory-facts`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json()).toHaveLength(0);

    await app.close();
  });

  it('rejects a member who neither owns the agent nor holds an admin/owner role', async () => {
    const app = await buildApp({ db });
    const { agentId } = await setupOwnerWithAgent(app);
    const member = createUser(db, { email: 'member@example.com', displayName: 'Member', passwordHash: 'x', role: 'member' });
    const memberToken = createSession(db, member.id);

    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/memory-facts`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { content: 'Should not be allowed.' },
    });
    expect(create.statusCode).toBe(403);

    await app.close();
  });

  it('returns 404 for a nonexistent agent', async () => {
    const app = await buildApp({ db });
    const { token } = await setupOwnerWithAgent(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/does-not-exist/memory-facts',
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'Anything.' },
    });
    expect(create.statusCode).toBe(404);

    await app.close();
  });

  it('returns 404 for a conversation with no summary yet', async () => {
    const app = await buildApp({ db });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const token = setup.json().token as string;
    const other = createUser(db, { email: 'other@example.com', displayName: 'Other', passwordHash: 'x', role: 'member' });
    const dm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: other.id, participantType: 'user' },
    });
    const conversationId = dm.json().id as string;

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/summary`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(404);

    await app.close();
  });

  it('returns a generated summary once one exists', async () => {
    const app = await buildApp({ db });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const token = setup.json().token as string;
    const other = createUser(db, { email: 'other2@example.com', displayName: 'Other2', passwordHash: 'x', role: 'member' });
    const dm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: other.id, participantType: 'user' },
    });
    const conversationId = dm.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'summarize me' },
    });
    await updateConversationSummary(db, conversationId);

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/summary`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().summary).toContain('summarize me');

    await app.close();
  });
});
