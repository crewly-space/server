import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createSession } from '../auth/session.js';
import { createProviderConfig } from '../providers/repository.js';
import { createAgent } from './repository.js';

describe('agent routes', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    // An agent cannot be created for a provider that is not configured, so
    // every test that expects a successful create needs one in place.
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'sk-test' });
  });

  afterEach(() => {
    db.close();
  });

  async function setupAndGetToken(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    return setup.json().token as string;
  }

  it('creates and lists agents for the authenticated user', async () => {
    const app = await buildApp({ db });
    const token = await setupAndGetToken(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Researcher',
        modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().name).toBe('Researcher');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    await app.close();
  });

  it('returns 400 with invalid_request for an invalid body', async () => {
    const app = await buildApp({ db });
    const token = await setupAndGetToken(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: '', modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' } },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_request');
    expect(Array.isArray(body.issues)).toBe(true);

    await app.close();
  });

  it('rejects agent creation without authentication', async () => {
    const app = await buildApp({ db });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: { name: 'Nope', modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'x' } },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('refuses an agent whose model provider is not configured with 409', async () => {
    const app = await buildApp({ db });
    const token = await setupAndGetToken(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Orphan',
        modelPolicy: { defaultProviderId: 'not-configured', defaultModel: 'claude-sonnet-5' },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('provider_not_configured');

    await app.close();
  });

  it('scopes GET /api/v1/agents to authenticated user only', async () => {
    const app = await buildApp({ db });
    const userAToken = await setupAndGetToken(app);

    // Create user B directly in the database
    const userB = createUser(db, {
      email: 'user-b@example.com',
      displayName: 'User B',
      passwordHash: 'x',
      role: 'member',
    });
    const userBToken = createSession(db, userB.id);

    // Create agent as user A
    const createA = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        name: 'Agent A',
        modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      },
    });
    expect(createA.statusCode).toBe(201);

    // Create agent as user B
    const createB = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${userBToken}` },
      payload: {
        name: 'Agent B',
        modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      },
    });
    expect(createB.statusCode).toBe(201);

    // List agents as user A, should only see Agent A
    const listA = await app.inject({
      method: 'GET',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${userAToken}` },
    });
    expect(listA.statusCode).toBe(200);
    const agentsA = listA.json() as Array<{ name: string }>;
    expect(agentsA).toHaveLength(1);
    expect(agentsA[0].name).toBe('Agent A');

    // List agents as user B, should only see Agent B
    const listB = await app.inject({
      method: 'GET',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${userBToken}` },
    });
    expect(listB.statusCode).toBe(200);
    const agentsB = listB.json() as Array<{ name: string }>;
    expect(agentsB).toHaveLength(1);
    expect(agentsB[0].name).toBe('Agent B');

    await app.close();
  });
});
