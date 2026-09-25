import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { buildApp } from '../app.js';

describe('incoming channel webhooks', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let channelId: string;
  beforeEach(async () => {
    db = openSqlite(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
    app = await buildApp({ db, publicUrl: 'https://crewly.test' });
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' } });
    token = setup.json().token;
    const channel = await app.inject({ method: 'POST', url: '/api/v1/channels', headers: { authorization: `Bearer ${token}` }, payload: { name: 'alerts' } });
    channelId = channel.json().id;
  });
  afterEach(async () => { await app.close(); db.close(); });

  it('creates a one-time secret, preserves structured fields, and deduplicates event retries', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: 'POST', url: `/api/v1/channels/${channelId}/webhooks`, headers, payload: { name: 'Sentry' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ webhook: { channelId, name: 'Sentry' } });
    expect(created.json().endpoint).toContain('https://crewly.test/api/v1/webhooks/');
    const endpoint = created.json().endpoint as string;
    const payload = { title: 'Payment failed', body: 'Checkout is down', severity: 'critical', source_url: 'https://sentry.test/1', event_id: 'evt-1' };
    const first = await app.inject({ method: 'POST', url: endpoint.replace('https://crewly.test', ''), payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: endpoint.replace('https://crewly.test', ''), payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true, messageId: first.json().messageId });
    const history = await app.inject({ method: 'GET', url: `/api/v1/conversations/${channelId}/messages`, headers });
    expect(history.json()[0]).toMatchObject({ authorType: 'integration', authorId: `webhook:${created.json().webhook.id}` });
    expect(history.json()[0].body).toContain('Severity: critical');
  });

  it('rotates and revokes the secret without changing the channel', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: 'POST', url: `/api/v1/channels/${channelId}/webhooks`, headers, payload: { name: 'CI' } });
    const oldEndpoint = created.json().endpoint as string;
    const rotated = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${created.json().webhook.id}/rotate`, headers });
    expect(rotated.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: oldEndpoint.replace('https://crewly.test', ''), payload: { body: 'old' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: rotated.json().endpoint.replace('https://crewly.test', ''), payload: { body: 'new' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/v1/webhooks/${created.json().webhook.id}/revoke`, headers })).json().revokedAt).toBeTruthy();
  });
});
