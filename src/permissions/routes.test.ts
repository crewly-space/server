import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createSession } from '../auth/session.js';
import { createUser } from '../users/repository.js';
import { createProviderConfig } from '../providers/repository.js';

describe('server roles and permissions', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => db.close());

  async function setup() {
    const app = await buildApp({ db });
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const ownerToken = first.json().token as string;
    const member = createUser(db, { email: 'member@example.com', displayName: 'Member', passwordHash: 'x', role: 'member' });
    return { app, ownerToken, member, memberToken: createSession(db, member.id) };
  }

  it('lets an owner create, edit, assign, and enforce a custom role', async () => {
    const { app, ownerToken, member, memberToken } = await setup();
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'sk-test' });
    const role = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Provider steward', description: 'Can manage model connections.', permissions: ['providers.manage'] },
    });
    expect(role.statusCode).toBe(201);
    expect(role.json().permissions).toEqual(['providers.manage']);

    const assigned = await app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${role.json().id}/members/${member.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(assigned.statusCode).toBe(204);

    const providers = await app.inject({ method: 'GET', url: '/api/v1/providers', headers: { authorization: `Bearer ${memberToken}` } });
    expect(providers.statusCode).toBe(200);

    const catalog = await app.inject({ method: 'GET', url: '/api/v1/roles', headers: { authorization: `Bearer ${ownerToken}` } });
    expect(catalog.json().members.find((row: { userId: string }) => row.userId === member.id).roles).toContain(role.json().id);

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/roles/${role.json().id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Provider steward', description: 'Updated.', permissions: ['providers.manage', 'operations.view'] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().permissions).toEqual(['providers.manage', 'operations.view']);
    await app.close();
  });

  it('does not let a member create or assign server roles', async () => {
    const { app, memberToken } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { name: 'Nope', permissions: ['providers.manage'] },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
