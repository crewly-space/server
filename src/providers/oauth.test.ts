import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';

describe('connecting a provider by signing in to it', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  /** Stands in for OpenRouter's key-minting endpoint. */
  function openRouterStub(key = 'sk-or-v1-minted-for-this-server') {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ key }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, bodies };
  }

  async function setupOwner(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    return setup.json().token as string;
  }

  const callbackUrl = 'http://localhost:4000/settings/providers/callback';

  it('advertises which provider kinds support it', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/providers/oauth/kinds',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.json()).toEqual({ kinds: ['openrouter'] });
    await app.close();
  });

  it('starts a flow with PKCE and completes it into a stored provider', async () => {
    const { fetchImpl, bodies } = openRouterStub();
    const app = await buildApp({ db, fetchImpl });
    const token = await setupOwner(app);

    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/oauth/start',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'openrouter', callbackUrl },
    });
    expect(start.statusCode).toBe(200);
    const authorizeUrl = new URL(start.json().authorizeUrl);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://openrouter.ai/auth');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorizeUrl.searchParams.get('callback_url')).toBe(callbackUrl);

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/oauth/complete',
      headers: { authorization: `Bearer ${token}` },
      payload: { state: start.json().state, code: 'authorization-code' },
    });

    expect(complete.statusCode).toBe(201);
    expect(complete.json()).toMatchObject({ id: 'openrouter', kind: 'openrouter', hasApiKey: true });
    // The minted key is a credential and must never come back out of the API.
    expect(complete.json().apiKey).toBeUndefined();
    // The verifier, not the challenge, is what gets sent on exchange.
    expect(bodies[0]).toMatchObject({ code: 'authorization-code', code_challenge_method: 'S256' });
    expect(String((bodies[0] as { code_verifier: string }).code_verifier).length).toBeGreaterThan(20);

    await app.close();
  });

  it('refuses to redeem the same state twice', async () => {
    const { fetchImpl } = openRouterStub();
    const app = await buildApp({ db, fetchImpl });
    const token = await setupOwner(app);
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/oauth/start',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'openrouter', callbackUrl },
    });
    const payload = { state: start.json().state, code: 'authorization-code' };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/oauth/complete',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/oauth/complete',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a state the server never issued', async () => {
    const { fetchImpl } = openRouterStub();
    const app = await buildApp({ db, fetchImpl });
    const token = await setupOwner(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/oauth/complete',
      headers: { authorization: `Bearer ${token}` },
      payload: { state: 'forged', code: 'authorization-code' },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('requires a session', async () => {
    const app = await buildApp({ db });
    await setupOwner(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/oauth/start',
      payload: { kind: 'openrouter', callbackUrl },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('reports a provider that refuses the exchange instead of storing nothing silently', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
    const app = await buildApp({ db, fetchImpl });
    const token = await setupOwner(app);
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/oauth/start',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'openrouter', callbackUrl },
    });

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/oauth/complete',
      headers: { authorization: `Bearer ${token}` },
      payload: { state: start.json().state, code: 'authorization-code' },
    });

    expect(complete.statusCode).toBe(502);
    expect(complete.json().error).toBe('provider_oauth_failed');

    const providers = await app.inject({
      method: 'GET',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(providers.json()).toEqual([]);
    await app.close();
  });

  it('will not start a second flow for a provider id that already exists', async () => {
    const { fetchImpl } = openRouterStub();
    const app = await buildApp({ db, fetchImpl });
    const token = await setupOwner(app);
    await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: { id: 'openrouter', kind: 'openrouter', apiKey: 'sk-existing' },
    });

    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/oauth/start',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'openrouter', callbackUrl },
    });

    expect(start.statusCode).toBe(409);
    await app.close();
  });
});
