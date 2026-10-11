import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { buildApp } from '../app.js';
import { connectorCall, getConnector, setConnectorGrants } from './service.js';

describe('expiring connector tokens', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let headers: { authorization: string };
  let ownerId: string;
  let renewals: URLSearchParams[];
  let renewal: () => Response;
  let apiTokens: string[];
  let stub: typeof fetch;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    renewals = [];
    apiTokens = [];
    renewal = () => Response.json({ access_token: 'gh-token-2', refresh_token: 'ghr-2', expires_in: 28800, refresh_token_expires_in: 15897600 });
    process.env.CREWLY_GITHUB_CLIENT_ID = 'client';
    process.env.CREWLY_GITHUB_CLIENT_SECRET = 'secret';
    stub = async (input, init) => {
        const url = String(input);
        if (url === 'https://github.com/login/oauth/access_token') {
          const body = typeof init?.body === 'string' && init.body.startsWith('{') ? undefined : new URLSearchParams(String(init?.body));
          if (body?.get('grant_type') === 'refresh_token') { renewals.push(body); await new Promise((resolve) => setTimeout(resolve, 5)); return renewal(); }
          return Response.json({ access_token: 'gh-token-1', refresh_token: 'ghr-1', expires_in: 60 });
        }
        if (url.startsWith('https://api.github.com/')) {
          apiTokens.push(String(new Headers(init?.headers).get('authorization')));
          return Response.json({ id: 42, login: 'octocat', html_url: 'https://github.com/octocat' });
        }
        throw new Error(`unexpected request to ${url}`);
    };
    app = await buildApp({ db, trustedAppOrigins: ['https://crewly.test'], githubOAuth: { clientId: 'client', clientSecret: 'secret' }, fetchImpl: stub });
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' } });
    headers = { authorization: `Bearer ${setup.json().token}` };
    ownerId = setup.json().user.id;
  });

  afterEach(async () => {
    delete process.env.CREWLY_GITHUB_CLIENT_ID;
    delete process.env.CREWLY_GITHUB_CLIENT_SECRET;
    await app.close(); db.close();
  });

  async function connectGitHub(): Promise<string> {
    const started = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/github/start', headers, payload: { callbackUrl: 'https://crewly.test/?connector=github' } });
    const done = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/github/complete', headers, payload: { state: started.json().state, code: 'code' } });
    expect(done.statusCode).toBe(201);
    const id = done.json().id as string;
    setConnectorGrants(db, id, [{ granteeType: 'agent', granteeId: 'agent-1', capability: 'read_profile' }], { type: 'user', id: ownerId });
    return id;
  }
  it('keeps the refresh token and renews an expiring token once, before the call', async () => {
    const id = await connectGitHub();
    const row = db.prepare('SELECT refresh_ciphertext, token_expires_at, oauth_app FROM connectors WHERE id = ?').get(id) as Record<string, string>;
    expect(row.refresh_ciphertext).toBeTruthy();
    expect(row.refresh_ciphertext).not.toContain('ghr-1');
    expect(row.oauth_app).toBe('local');

    // The admin's check runs the renewal; two at once share one.
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/connectors/${id}/refresh`, headers }),
      app.inject({ method: 'POST', url: `/api/v1/connectors/${id}/refresh`, headers }),
    ]);
    expect(a.json().status).toBe('connected');
    expect(b.json().status).toBe('connected');
    expect(renewals).toHaveLength(1);
    expect(renewals[0].get('refresh_token')).toBe('ghr-1');
    expect(renewals[0].get('client_secret')).toBe('secret');
    expect(apiTokens.at(-1)).toBe('Bearer gh-token-2');

    // Now valid for hours: no further renewal.
    await app.inject({ method: 'POST', url: `/api/v1/connectors/${id}/refresh`, headers });
    expect(renewals).toHaveLength(1);
    const audit = (await app.inject({ method: 'GET', url: `/api/v1/connectors/${id}/audit`, headers })).json().entries;
    expect(audit.filter((entry: { action: string }) => entry.action === 'token_renewed')).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('gh-token-2');
  });

  it('asks for a new sign-in when the provider refuses the refresh token', async () => {
    const id = await connectGitHub();
    // GitHub reports a dead refresh token with a 200 and an error body.
    renewal = () => Response.json({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
    const checked = await app.inject({ method: 'POST', url: `/api/v1/connectors/${id}/refresh`, headers });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({ status: 'permission_revoked' });
    expect(getConnector(db, id)?.lastError).toContain('Reconnect');
  });

  it('reports the provider being down without dropping the connection', async () => {
    const id = await connectGitHub();
    renewal = () => new Response('oops', { status: 503 });
    const checked = await app.inject({ method: 'POST', url: `/api/v1/connectors/${id}/refresh`, headers });
    expect(checked.statusCode).toBe(502);
    expect(getConnector(db, id)?.status).toBe('connected');
  });

  it('renews before an agent call, with this server\'s app from the environment', async () => {
    const id = await connectGitHub();
    const result = await connectorCall(db, { connectorId: id, agentId: 'agent-1', capability: 'read_profile', operation: 'read', payload: {} }, stub);
    expect(result).toMatchObject({ login: 'octocat' });
    expect(renewals).toHaveLength(1);
    expect(apiTokens.at(-1)).toBe('Bearer gh-token-2');
  });

});
