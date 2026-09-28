import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { encryptDatabaseSecret } from '../db/secrets.js';
import { buildApp } from '../app.js';

/** What Crewly Cloud answers; each test sets it. */
let cloud: (url: string) => Response;

function link(db: Database, status: 'connected' | 'pending' | 'revoked', scopes: string[]): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO crewly_connection (id, cloud_url, status, instance_id, credential_ciphertext, credential_version, scopes, connected_at, updated_at,
       user_code, verification_url, link_expires_at, poll_interval)
     VALUES (1, 'https://crewly.test', ?, 'instance-1', ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(status, status === 'connected' ? encryptDatabaseSecret(db, 'crewly_inst_test') : null, JSON.stringify(scopes), now, now,
    status === 'pending' ? 'ABCD' : null, status === 'pending' ? 'https://crewly.test/link' : null, status === 'pending' ? now : null, status === 'pending' ? 5 : null);
}

describe('Crewly Gateway status', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    cloud = () => new Response(JSON.stringify({ models: [{ id: 'managed-small', displayName: 'Managed Small', contextWindow: 4096, providerId: 'crewly-gateway' }] }), { status: 200 });
    app = await buildApp({ db, fetchImpl: async (input) => cloud(String(input)) });
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' } });
    token = setup.json().token;
  });
  afterEach(async () => { await app.close(); db.close(); });

  const status = async () => (await app.inject({ method: 'GET', url: '/api/v1/providers/crewly-gateway/status', headers: { authorization: `Bearer ${token}` } })).json();
  const addGateway = () => app.inject({ method: 'POST', url: '/api/v1/providers', headers: { authorization: `Bearer ${token}` }, payload: { id: 'crewly-gateway', kind: 'crewly-gateway' } });

  it('says to link the server first, and will not add a Gateway that cannot answer', async () => {
    expect(await status()).toMatchObject({ state: 'not_linked', models: [] });
    const added = await addGateway();
    expect(added.statusCode).toBe(409);
    expect(added.json()).toMatchObject({ error: 'gateway_not_ready', state: 'not_linked' });
    expect(added.json().message).toMatch(/Connect this server to Crewly/);
  });

  it('names the missing grant when the server is linked without AI Gateway', async () => {
    link(db, 'connected', ['mail:send']);
    expect(await status()).toMatchObject({ state: 'missing_scope', missingScopes: ['inference', 'models:read'] });
  });

  it('tells a waiting or revoked link apart', async () => {
    link(db, 'pending', []);
    expect((await status()).state).toBe('link_pending');
    db.prepare("UPDATE crewly_connection SET status = 'revoked'").run();
    expect((await status()).state).toBe('revoked');
  });

  it('says when Crewly itself offers no Gateway, or cannot be reached', async () => {
    link(db, 'connected', ['inference', 'models:read']);
    cloud = () => new Response(JSON.stringify({ error: 'gateway_not_configured' }), { status: 503 });
    expect(await status()).toMatchObject({ state: 'not_offered' });
    cloud = () => { throw new Error('offline'); };
    expect(await status()).toMatchObject({ state: 'unavailable' });
  });

  it('is ready with the models Crewly offers, and then can be added', async () => {
    link(db, 'connected', ['inference', 'models:read']);
    expect(await status()).toMatchObject({ state: 'ready', models: [{ id: 'managed-small' }] });
    const added = await addGateway();
    expect(added.statusCode, added.body).toBe(201);
  });
});
