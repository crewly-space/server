import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';

describe('provider routes', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
  });

  async function setupOwner(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    return setup.json().token as string;
  }

  it('lets an owner create a provider and never echoes the api key back', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-secret' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().apiKey).toBeUndefined();
    expect(create.json().hasApiKey).toBe(true);

    await app.close();
  });

  it('rejects provider creation from a member-role user', async () => {
    const app = await buildApp({ db });
    await setupOwner(app);
    const member = createUser(db, { email: 'member@example.com', displayName: 'Member', passwordHash: 'x', role: 'member' });
    const memberToken = createSession(db, member.id);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-secret' },
    });
    expect(create.statusCode).toBe(403);

    await app.close();
  });

  it('lists providers without api keys', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);
    await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-secret' },
    });

    const list = await app.inject({ method: 'GET', url: '/api/v1/providers', headers: { authorization: `Bearer ${token}` } });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].apiKey).toBeUndefined();

    await app.close();
  });

  it('does not let a member enumerate provider configuration', async () => {
    const app = await buildApp({ db });
    await setupOwner(app);
    const member = createUser(db, { email: 'member-list@example.com', displayName: 'Member', passwordHash: 'x', role: 'member' });
    const memberToken = createSession(db, member.id);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(list.statusCode).toBe(403);
    await app.close();
  });

  it('lets a member see only provider availability needed to configure agents', async () => {
    const app = await buildApp({ db });
    const ownerToken = await setupOwner(app);
    await app.inject({
      method: 'POST', url: '/api/v1/providers', headers: { authorization: `Bearer ${ownerToken}` },
      payload: { id: 'compatible', kind: 'openai-compatible', apiKey: 'sk-secret', baseUrl: 'https://private.example/v1' },
    });
    const member = createUser(db, { email: 'member-available@example.com', displayName: 'Member', passwordHash: 'x', role: 'member' });
    const memberToken = createSession(db, member.id);
    const list = await app.inject({
      method: 'GET', url: '/api/v1/providers/available',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([{ id: 'compatible', kind: 'openai-compatible', hasApiKey: true, status: 'unknown' }]);
    expect(list.body).not.toContain('private.example');
    await app.close();
  });

  it('returns a clean conflict for a duplicate provider id', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);
    const request = {
      method: 'POST' as const,
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'duplicate', kind: 'anthropic', apiKey: 'sk-secret' },
    };
    expect((await app.inject(request)).statusCode).toBe(201);
    const duplicate = await app.inject(request);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'provider_exists' });
    await app.close();
  });

  it('rotates and deletes provider credentials without returning the key', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);
    await app.inject({
      method: 'POST', url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'openai-default', kind: 'openai', apiKey: 'sk-old' },
    });
    const update = await app.inject({
      method: 'PATCH', url: '/api/v1/providers/openai-default',
      headers: { authorization: `Bearer ${token}` },
      payload: { apiKey: 'sk-new' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().hasApiKey).toBe(true);
    expect(update.json().apiKey).toBeUndefined();
    expect((db.prepare('SELECT api_key FROM provider_configs WHERE id = ?').get('openai-default') as { api_key: string }).api_key).not.toContain('sk-new');

    const remove = await app.inject({
      method: 'DELETE', url: '/api/v1/providers/openai-default',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(remove.statusCode).toBe(204);
    expect((await app.inject({
      method: 'DELETE', url: '/api/v1/providers/openai-default',
      headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 for models on an unknown provider', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);

    const models = await app.inject({
      method: 'GET',
      url: '/api/v1/providers/nonexistent/models',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(models.statusCode).toBe(404);

    await app.close();
  });

  it('proxies GET /api/v1/providers/:id/models for an anthropic provider', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);
    await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-secret' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }],
    }), { status: 200 })));

    const models = await app.inject({
      method: 'GET',
      url: '/api/v1/providers/anthropic-default/models',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual([
      { id: 'claude-opus-5', providerId: 'anthropic-default', displayName: 'Claude Opus 5', contextWindow: 200000 },
    ]);

    await app.close();
  });

  it('lists a connected OpenRouter provider as a sorted, named catalogue', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);
    await app.inject({
      method: 'POST', url: '/api/v1/providers', headers: { authorization: `Bearer ${token}` },
      payload: { id: 'openrouter', kind: 'openrouter', apiKey: 'sk-or-secret' },
    });
    const upstream = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [
      { id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 Mini', context_length: 400000 },
      { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', context_length: 1000000 },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    const models = await app.inject({
      method: 'GET', url: '/api/v1/providers/openrouter/models', headers: { authorization: `Bearer ${token}` },
    });
    expect(models.statusCode).toBe(200);
    expect(upstream.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/models');
    expect(models.json().map((m: { displayName: string }) => m.displayName)).toEqual([
      'Anthropic: Claude Sonnet 5', 'OpenAI: GPT-5 Mini',
    ]);
    await app.close();
  });

  it('names why a model list failed instead of one generic 502', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);
    await app.inject({
      method: 'POST', url: '/api/v1/providers', headers: { authorization: `Bearer ${token}` },
      payload: { id: 'openai-default', kind: 'openai', apiKey: 'sk-secret-never-logged' },
    });
    const cases: [number, string, boolean][] = [
      [401, 'provider_auth_failed', false],
      [429, 'provider_rate_limited', true],
      [404, 'provider_models_unsupported', false],
      [503, 'provider_unavailable', true],
    ];
    for (const [status, code, retryable] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
      const models = await app.inject({
        method: 'GET', url: '/api/v1/providers/openai-default/models', headers: { authorization: `Bearer ${token}` },
      });
      expect(models.statusCode).toBe(502);
      expect(models.json()).toMatchObject({ error: code, retryable });
      expect(models.json().message).not.toContain('sk-secret');
    }
    await app.close();
  });

  it('rejects creating a remote-kind provider with no apiKey (400, not 201)', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'anthropic-default', kind: 'anthropic' },
    });
    expect(create.statusCode).toBe(400);

    await app.close();
  });

  it('rejects creating an openai-compatible provider with an apiKey but no baseUrl (400, not 201)', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'compat-default', kind: 'openai-compatible', apiKey: 'sk-secret' },
    });
    expect(create.statusCode).toBe(400);

    await app.close();
  });

  it('still creates a valid remote-kind provider with both apiKey and baseUrl (no regression)', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'compat-default', kind: 'openai-compatible', apiKey: 'sk-secret', baseUrl: 'https://my-local-server/v1' },
    });
    expect(create.statusCode).toBe(201);

    await app.close();
  });

  it('still creates an agentd-backed provider (ollama) with neither apiKey nor baseUrl', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'ollama-default', kind: 'ollama' },
    });
    expect(create.statusCode).toBe(201);

    await app.close();
  });

  it('returns 502 when a remote provider is unreachable while listing models', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);
    await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'openai-default', kind: 'openai', apiKey: 'sk-secret' },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );

    const models = await app.inject({
      method: 'GET',
      url: '/api/v1/providers/openai-default/models',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(models.statusCode).toBe(502);

    await app.close();
  });
});
