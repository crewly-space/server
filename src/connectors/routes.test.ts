import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { buildApp } from '../app.js';
import { connectorCredential, setConnectorGrants } from './service.js';

describe('first-class connectors', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let ownerId: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const responses = [
      new Response(JSON.stringify({ access_token: 'gh-secret-token' }), { status: 200 }),
      new Response(JSON.stringify({ id: 42, login: 'octocat', html_url: 'https://github.com/octocat' }), { status: 200 }),
    ];
    app = await buildApp({
      db,
      trustedAppOrigins: ['https://crewly.test'],
      githubOAuth: { clientId: 'client', clientSecret: 'secret' },
      gitlabOAuth: { clientId: 'gitlab-client', clientSecret: 'gitlab-secret' },
      linearOAuth: { clientId: 'linear-client', clientSecret: 'linear-secret' },
      notionOAuth: { clientId: 'notion-client', clientSecret: 'notion-secret' },
      googleDriveOAuth: { clientId: 'google-client', clientSecret: 'google-secret' },
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('gitlab.com/oauth/token')) return new Response(JSON.stringify({ access_token: 'gitlab-secret-token' }), { status: 200 });
        if (url.includes('gitlab.com/api/v4/user')) return new Response(JSON.stringify({ id: 77, username: 'fox', web_url: 'https://gitlab.com/fox' }), { status: 200 });
        if (url.includes('api.linear.app/oauth/token')) return new Response(JSON.stringify({ access_token: 'linear-secret-token' }), { status: 200 });
        if (url.includes('api.linear.app/graphql')) return new Response(JSON.stringify({ data: { viewer: { id: 'workspace-1', name: 'Crewly Space', url: 'https://linear.app/acme' } } }), { status: 200 });
        if (url.includes('api.notion.com/v1/oauth/token')) return new Response(JSON.stringify({ access_token: 'notion-secret-token', workspace_id: 'notion-workspace', workspace_name: 'Crewly Notes', bot_id: 'notion-bot' }), { status: 200 });
        if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'google-secret-token' }), { status: 200 });
        if (url.includes('googleapis.com/oauth2/v3/userinfo')) return new Response(JSON.stringify({ sub: 'google-user', name: 'Crewly Drive' }), { status: 200 });
        return responses.shift()!;
      },
    });
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' } });
    token = setup.json().token;
    ownerId = setup.json().user.id;
  });

  afterEach(async () => { await app.close(); db.close(); });

  const headers = () => ({ authorization: `Bearer ${token}` });

  it('connects GitHub through OAuth, redacts the credential, and separates grants from connection', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/github/start', headers: headers(), payload: { callbackUrl: 'https://crewly.test/?connector=github' } });
    expect(started.statusCode).toBe(200);
    expect(started.json().authorizeUrl).toContain('github.com/login/oauth/authorize');

    const connected = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/github/complete', headers: headers(), payload: { state: started.json().state, code: 'code-from-github' } });
    expect(connected.statusCode).toBe(201);
    expect(connected.json()).toMatchObject({ provider: 'github', accountName: 'octocat', status: 'connected', scopes: ['read:user', 'repo'] });
    expect(JSON.stringify(connected.json())).not.toContain('gh-secret-token');

    const connectorId = connected.json().id as string;
    expect((await app.inject({ method: 'GET', url: '/api/v1/connectors', headers: headers() })).json().connectors).toHaveLength(1);
    expect(() => connectorCredential(db, { connectorId, granteeType: 'agent', granteeId: 'agent-1', capability: 'read_issues' }, { type: 'agent', id: 'agent-1' })).toThrow('connector_capability_not_granted');

    setConnectorGrants(db, connectorId, [{ granteeType: 'agent', granteeId: 'agent-1', capability: 'read_issues' }], { type: 'user', id: ownerId });
    expect(connectorCredential(db, { connectorId, granteeType: 'agent', granteeId: 'agent-1', capability: 'read_issues' }, { type: 'agent', id: 'agent-1' }).token).toBe('gh-secret-token');
    const audit = (await app.inject({ method: 'GET', url: `/api/v1/connectors/${connectorId}/audit`, headers: headers() })).json().entries;
    expect(audit.some((entry: { action: string }) => entry.action === 'call_authorized')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('gh-secret-token');
  });

  it('revokes the credential and reports the revoked state without deleting history', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/github/start', headers: headers(), payload: { callbackUrl: 'https://crewly.test/?connector=github' } });
    const connected = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/github/complete', headers: headers(), payload: { state: started.json().state, code: 'code' } });
    const id = connected.json().id as string;
    const revoked = await app.inject({ method: 'POST', url: `/api/v1/connectors/${id}/revoke`, headers: headers() });
    expect(revoked.json()).toMatchObject({ id, status: 'revoked', scopes: [] });
    expect((await app.inject({ method: 'GET', url: `/api/v1/connectors/${id}/audit`, headers: headers() })).json().entries.some((entry: { action: string }) => entry.action === 'revoked')).toBe(true);
  });

  it('connects Linear through OAuth and advertises its scoped provider capabilities', async () => {
    const providers = await app.inject({ method: 'GET', url: '/api/v1/connectors/providers', headers: headers() });
    expect(providers.json().providers).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'linear', capabilities: expect.arrayContaining(['read_issues', 'create_issue']) })]));
    const started = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/linear/start', headers: headers(), payload: { callbackUrl: 'https://crewly.test/?connector=linear' } });
    expect(started.statusCode).toBe(200);
    expect(started.json().authorizeUrl).toContain('linear.app/oauth/authorize');
    const connected = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/linear/complete', headers: headers(), payload: { state: started.json().state, code: 'linear-code' } });
    expect(connected.statusCode).toBe(201);
    expect(connected.json()).toMatchObject({ provider: 'linear', accountName: 'Crewly Space', status: 'connected', scopes: ['read', 'write'] });
    expect(JSON.stringify(connected.json())).not.toContain('linear-secret-token');
  });

  it('discovers and connects GitLab, Notion and Google Drive through the generic OAuth API', async () => {
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/connectors/providers', headers: headers() })).json().providers;
    expect(listed.map((entry: { provider: string }) => entry.provider)).toEqual(['github', 'gitlab', 'linear', 'notion', 'google-drive', 'slack']);

    for (const expected of [
      { provider: 'gitlab', authorizeHost: 'gitlab.com', accountName: 'fox' },
      { provider: 'notion', authorizeHost: 'api.notion.com', accountName: 'Crewly Notes' },
      { provider: 'google-drive', authorizeHost: 'accounts.google.com', accountName: 'Crewly Drive' },
    ]) {
      const callbackUrl = `https://crewly.test/?connector=${expected.provider}`;
      const started = await app.inject({ method: 'POST', url: `/api/v1/connectors/oauth/${expected.provider}/start`, headers: headers(), payload: { callbackUrl } });
      expect(started.statusCode).toBe(200);
      expect(started.json().authorizeUrl).toContain(expected.authorizeHost);
      const connected = await app.inject({ method: 'POST', url: `/api/v1/connectors/oauth/${expected.provider}/complete`, headers: headers(), payload: { state: started.json().state, code: `${expected.provider}-code` } });
      expect(connected.statusCode).toBe(201);
      expect(connected.json()).toMatchObject({ provider: expected.provider, accountName: expected.accountName, status: 'connected' });
      expect(JSON.stringify(connected.json())).not.toContain('secret-token');
    }
  });
});
