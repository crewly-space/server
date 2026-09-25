import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';

describe('automation rules', () => {
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

  it('creates a secret webhook rule, runs its action, and records history', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: 'POST', url: '/api/v1/automations', headers,
      payload: {
        name: 'Post incidents', triggerType: 'webhook', conditions: { severity: 'critical' },
        actions: [{ type: 'post_message', conversationId: channelId, body: 'Incident received.' }],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ automation: { name: 'Post incidents', triggerType: 'webhook', webhookEndpoint: 'https://crewly.test/api/v1/automations/' + created.json().automation.id + '/webhook' } });
    const secret = created.json().webhookSecret as string;

    const ignored = await app.inject({ method: 'POST', url: `/api/v1/automations/${created.json().automation.id}/webhook`, headers: { 'x-crewly-automation-secret': secret }, payload: { severity: 'warning' } });
    expect(ignored.statusCode).toBe(202);
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/automations/${created.json().automation.id}/webhook`, headers: { 'x-crewly-automation-secret': secret, 'x-webhook-event-id': 'evt-1' }, payload: { severity: 'critical' } });
    expect(accepted.statusCode).toBe(202);
    const replay = await app.inject({ method: 'POST', url: `/api/v1/automations/${created.json().automation.id}/webhook`, headers: { 'x-crewly-automation-secret': secret, 'x-webhook-event-id': 'evt-1' }, payload: { severity: 'critical' } });
    expect(replay.statusCode).toBe(202);

    const messages = await app.inject({ method: 'GET', url: `/api/v1/conversations/${channelId}/messages`, headers });
    expect(messages.json()).toHaveLength(1);
    expect(messages.json()[0]).toMatchObject({ authorType: 'integration', body: 'Incident received.' });
    const runs = await app.inject({ method: 'GET', url: '/api/v1/automations/runs', headers });
    expect(runs.json().runs).toHaveLength(1);
    expect(runs.json().runs[0]).toMatchObject({ status: 'succeeded', dedupeKey: 'evt-1' });
  });

  it('does not expose automation management to a member', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/automations', headers: { authorization: `Bearer ${token.slice(0, 0)}invalid` } });
    expect(response.statusCode).toBe(401);
  });
});
