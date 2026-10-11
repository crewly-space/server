import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { resetBrokerCache } from '../connectors/broker.js';
import { crewlyServiceCredential } from '../crewly/connection.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createInvite, getInvite } from '../users/invites.js';

/*
 * A server Crewly Cloud hosts: used through the app, given its Crewly
 * connection by Cloud, joined by invite through Cloud, and connected to
 * GitHub and the rest through Crewly's own OAuth apps.
 */

const DEPLOYMENT_ID = '6f1b1a2c-6f2a-4b5e-9c3d-2f6a7b8c9d01';
const CLOUD = 'https://cloud.test';
const keyPair = generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function signed(prefix: string, claims: Record<string, unknown>): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    nonce: Math.random().toString(36).slice(2).padEnd(16, 'x'), iat: issuedAt, exp: issuedAt + 120, ...claims,
  })).toString('base64url');
  return `${prefix}.${payload}.${sign(null, Buffer.from(`${prefix}.${payload}`), keyPair.privateKey).toString('base64url')}`;
}

const person = (overrides: Record<string, unknown> = {}) => ({
  deploymentId: DEPLOYMENT_ID, cloudUserId: 'owner-cloud-id', email: 'owner@example.com', displayName: 'Owner', orgRole: 'owner', ...overrides,
});
const guest = { cloudUserId: 'guest-cloud-id', email: 'guest@example.com', displayName: 'Guest', orgRole: 'admin' };
const managed = (overrides: Record<string, unknown> = {}) => signed('c1', {
  deploymentId: DEPLOYMENT_ID, cloudUrl: CLOUD, instanceId: 'instance-1', credential: 'crewly_inst_secret',
  credentialVersion: 1, scopes: ['connectors', 'mail:send'], ...overrides,
});

describe('a hosted server', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cloudCalls: Array<{ url: string; body: unknown; authorization: string | null }>;
  let sentMail: string[];

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    resetBrokerCache();
    cloudCalls = [];
    sentMail = [];
    app = await buildApp({
      mailDefault: { provider: 'resend', apiKey: 're_test', fromAddress: 'Crewly <hi@example.com>' },
      db,
      cloudHandoff: { publicKey, deploymentId: DEPLOYMENT_ID },
      crewlyCloudUrl: CLOUD,
      trustedAppOrigins: [CLOUD],
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.startsWith(CLOUD)) {
          cloudCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined,
            authorization: new Headers(init?.headers).get('authorization') });
        }
        if (url === `${CLOUD}/api/v1/instance/connectors`) return Response.json({ providers: [{ provider: 'github' }] });
        if (url === `${CLOUD}/api/v1/instance/connectors/github/authorize`) {
          return Response.json({ state: 'state-from-crewly-0123456789', clientId: 'crewly-github', redirectUri: `${CLOUD}/api/v1/connectors/oauth/callback` }, { status: 201 });
        }
        if (url === `${CLOUD}/api/v1/instance/connectors/github/token`) return Response.json({ status: 200, body: { access_token: 'gh-token-via-crewly' } });
        if (url === 'https://api.github.com/user') return Response.json({ id: 7, login: 'octocat' });
        if (url.startsWith('https://api.resend.com')) { sentMail.push(String(init?.body)); return Response.json({ id: 'email-1' }); }
        throw new Error(`unexpected request to ${url}`);
      },
    });
  });

  afterEach(async () => { await app.close(); db.close(); });

  const enter = async (token: string, inviteToken?: string) => app.inject({
    method: 'POST', url: '/api/v1/auth/cloud-handoff', payload: { token, ...(inviteToken ? { inviteToken } : {}) },
  });

  it('sends browsers to the Crewly app instead of serving its own', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe(`${CLOUD}/?server=${DEPLOYMENT_ID}`);
    const join = await app.inject({ method: 'GET', url: '/join' });
    expect(join.headers.location).toBe(`${CLOUD}/join?server=${DEPLOYMENT_ID}`);
    // The API is not redirected.
    expect((await app.inject({ method: 'GET', url: '/api/v1/nothing-here' })).statusCode).toBe(404);
  });

  it('takes its Crewly connection from Cloud, once per token, and only its own', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/crewly/managed-connection', payload: { token: managed() } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'connected', instanceId: 'instance-1', scopes: ['connectors', 'mail:send'] });
    expect(crewlyServiceCredential(db, 'mail:send')).toMatchObject({ cloudUrl: CLOUD, credential: 'crewly_inst_secret' });

    const replay = managed();
    expect((await app.inject({ method: 'POST', url: '/api/v1/crewly/managed-connection', payload: { token: replay } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/crewly/managed-connection', payload: { token: replay } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/crewly/managed-connection', payload: { token: managed({ deploymentId: 'another' }) } })).statusCode).toBe(401);
    // A sign-in token is not a connection token, though the same key signs both.
    expect((await app.inject({ method: 'POST', url: '/api/v1/crewly/managed-connection', payload: { token: signed('v1', person()) } })).statusCode).toBe(401);
  });

  it('lets a guest in only with an invite, and never above it', async () => {
    const owner = await enter(signed('v1', person()));
    expect(owner.statusCode).toBe(201);

    expect((await enter(signed('g1', { deploymentId: DEPLOYMENT_ID, ...guest }))).statusCode).toBe(403);

    const { invite, code } = createInvite(db, { role: 'member', createdBy: owner.json().user.id });
    const joined = await enter(signed('g1', { deploymentId: DEPLOYMENT_ID, ...guest }), code);
    expect(joined.statusCode).toBe(201);
    // Cloud said admin; a guest is what the invite says.
    expect(joined.json().user).toMatchObject({ email: 'guest@example.com', role: 'member' });
    expect(getInvite(db, invite.id)?.usedAt).toBeTruthy();

    // Once joined, they come back without one.
    expect((await enter(signed('g1', { deploymentId: DEPLOYMENT_ID, ...guest }))).statusCode).toBe(201);
  });

  it('never makes a guest the first owner', async () => {
    expect((await enter(signed('g1', { deploymentId: DEPLOYMENT_ID, ...guest }))).statusCode).toBe(403);
  });

  it('emails invites that open in the Crewly app', async () => {
    const owner = (await enter(signed('v1', person()))).json().token as string;
    const response = await app.inject({
      method: 'POST', url: '/api/v1/invites', headers: { authorization: `Bearer ${owner}` },
      payload: { role: 'member', email: 'new@example.com' },
    });
    expect(response.statusCode).toBe(201);
    expect(sentMail.join('\n')).toContain(`${CLOUD}/join?server=${DEPLOYMENT_ID}#invite=`);
  });

  it('connects GitHub through Crewly with nothing set up here', async () => {
    const owner = (await enter(signed('v1', person()))).json().token as string;
    const headers = { authorization: `Bearer ${owner}` };
    await app.inject({ method: 'POST', url: '/api/v1/crewly/managed-connection', payload: { token: managed() } });

    const providers = (await app.inject({ method: 'GET', url: '/api/v1/connectors/providers', headers })).json().providers;
    expect(providers.find((entry: { provider: string }) => entry.provider === 'github')).toMatchObject({ configured: true, managed: true });
    expect(providers.find((entry: { provider: string }) => entry.provider === 'linear')).toMatchObject({ configured: false, managed: false });

    const started = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/github/start', headers,
      payload: { callbackUrl: `${CLOUD}/?connector=github` } });
    expect(started.statusCode).toBe(200);
    const authorize = new URL(started.json().authorizeUrl);
    expect(authorize.searchParams.get('client_id')).toBe('crewly-github');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${CLOUD}/api/v1/connectors/oauth/callback`);
    expect(authorize.searchParams.get('state')).toBe('state-from-crewly-0123456789');
    expect(cloudCalls.find((call) => call.url.endsWith('/authorize'))).toMatchObject({
      body: { returnUrl: `${CLOUD}/?connector=github` }, authorization: 'Bearer crewly_inst_secret',
    });

    const done = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/github/complete', headers,
      payload: { state: 'state-from-crewly-0123456789', code: 'code-from-github' } });
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({ provider: 'github', accountName: 'octocat', status: 'connected' });
    const exchange = cloudCalls.find((call) => call.url.endsWith('/token'));
    expect(exchange?.body).toMatchObject({ state: 'state-from-crewly-0123456789', code: 'code-from-github' });
    expect((exchange?.body as { codeVerifier: string }).codeVerifier.length).toBeGreaterThan(40);
  });
});
