import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { createProviderConfig } from '../providers/repository.js';

/*
 * Avatar modes (CRE-65): each person and each agent has one, stored on the
 * server so everyone sees them drawn the same way.
 */
describe('avatar modes', () => {
  let db: Database;
  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  async function setup() {
    const app = await buildApp({ db });
    const owner = await app.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const ownerToken = owner.json().token as string;
    await app.inject({
      method: 'POST', url: '/api/v1/users', headers: { authorization: `Bearer ${ownerToken}` },
      payload: { email: 'member@example.com', displayName: 'Member', password: 'member-secret-1' },
    });
    const member = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'member@example.com', password: 'member-secret-1' } });
    return { app, ownerToken, memberToken: member.json().token as string };
  }

  it('defaults everyone to Bloop and reports it on /auth/me', async () => {
    const { app, ownerToken } = await setup();
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${ownerToken}` } });
    expect(me.json()).toMatchObject({ displayName: 'Owner', avatarMode: 'bloop' });
    await app.close();
  });

  it('lets a member change their own avatar and name, and nothing else', async () => {
    const { app, memberToken } = await setup();
    const updated = await app.inject({
      method: 'PATCH', url: '/api/v1/users/me', headers: { authorization: `Bearer ${memberToken}` },
      payload: { avatarMode: 'blobatar', displayName: 'Sam' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ displayName: 'Sam', avatarMode: 'blobatar', role: 'member' });

    const rejected = await app.inject({
      method: 'PATCH', url: '/api/v1/users/me', headers: { authorization: `Bearer ${memberToken}` },
      payload: { avatarMode: 'robot' },
    });
    expect(rejected.statusCode).toBe(400);
    await app.close();
  });

  it('shows members everyone’s name and avatar, but not emails or roles', async () => {
    const { app, memberToken } = await setup();
    const directory = await app.inject({ method: 'GET', url: '/api/v1/users/directory', headers: { authorization: `Bearer ${memberToken}` } });
    expect(directory.statusCode).toBe(200);
    const users = directory.json().users as Array<Record<string, unknown>>;
    expect(users.map((user) => user.displayName).sort()).toEqual(['Member', 'Owner']);
    for (const user of users) {
      expect(Object.keys(user).sort()).toEqual(['avatarMode', 'displayName', 'id']);
    }
    await app.close();
  });

  it('stores an agent’s avatar and keeps it when an edit leaves it out', async () => {
    const { app, ownerToken } = await setup();
    createProviderConfig(db, { id: 'openai', kind: 'openai', apiKey: 'sk-test' });
    const modelPolicy = { defaultProviderId: 'openai', defaultModel: 'gpt-4o-mini' };
    const created = await app.inject({
      method: 'POST', url: '/api/v1/agents', headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Echo', modelPolicy, avatarMode: 'name' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().avatarMode).toBe('name');

    const edited = await app.inject({
      method: 'PATCH', url: `/api/v1/agents/${created.json().id}`, headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Echo 2', modelPolicy },
    });
    expect(edited.json()).toMatchObject({ name: 'Echo 2', avatarMode: 'name' });

    const plain = await app.inject({
      method: 'POST', url: '/api/v1/agents', headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Plain', modelPolicy },
    });
    expect(plain.json().avatarMode).toBe('bloop');
    await app.close();
  });
});
