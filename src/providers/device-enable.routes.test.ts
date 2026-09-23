import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { buildApp } from '../app.js';

describe('connecting a device-backed provider over HTTP', () => {
  let db: Database;
  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  async function owner(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    return { authorization: `Bearer ${setup.json().token as string}` };
  }

  it('reports what the devices did when Claude is connected, even when there are none', async () => {
    const app = await buildApp({ db });
    const headers = await owner(app);
    const created = await app.inject({ method: 'POST', url: '/api/v1/providers', headers,
      payload: { id: 'claude', kind: 'claude-subscription' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'claude', kind: 'claude-subscription', devices: [] });
    await app.close();
  });

  it('can ask the devices again for an existing provider, and only for device-backed ones', async () => {
    const app = await buildApp({ db });
    const headers = await owner(app);
    await app.inject({ method: 'POST', url: '/api/v1/providers', headers, payload: { id: 'claude', kind: 'claude-subscription' } });
    await app.inject({ method: 'POST', url: '/api/v1/providers', headers, payload: { id: 'openai', kind: 'openai', apiKey: 'sk-test' } });

    const again = await app.inject({ method: 'POST', url: '/api/v1/providers/claude/enable-on-devices', headers });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ devices: [] });

    expect((await app.inject({ method: 'POST', url: '/api/v1/providers/openai/enable-on-devices', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/providers/nope/enable-on-devices', headers })).statusCode).toBe(404);
    await app.close();
  });
});
