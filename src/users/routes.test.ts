import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';

describe('user management routes', () => {
  let db: Database;
  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  async function setupOwner(app: Awaited<ReturnType<typeof buildApp>>) {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    return response.json().token as string;
  }

  it('lets an owner create and list a member without exposing password hashes', async () => {
    const app = await buildApp({ db });
    const token = await setupOwner(app);
    const created = await app.inject({
      method: 'POST', url: '/api/v1/users', headers: { authorization: `Bearer ${token}` },
      payload: { email: 'MEMBER@example.com', displayName: 'New Member', password: 'member-secret-1', role: 'member' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ email: 'member@example.com', displayName: 'New Member', role: 'member' });
    expect(created.json()).not.toHaveProperty('password_hash');

    const listed = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { authorization: `Bearer ${token}` } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(2);
    expect(listed.json()[1]).not.toHaveProperty('password_hash');
    await app.close();
  });

  it('rejects duplicate users and blocks members from user management', async () => {
    const app = await buildApp({ db });
    const ownerToken = await setupOwner(app);
    const input = { email: 'member@example.com', displayName: 'Member', password: 'member-secret-1', role: 'member' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers: { authorization: `Bearer ${ownerToken}` }, payload: input })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers: { authorization: `Bearer ${ownerToken}` }, payload: input })).statusCode).toBe(409);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: input.email, password: input.password } });
    const memberToken = login.json().token as string;
    expect((await app.inject({ method: 'GET', url: '/api/v1/users', headers: { authorization: `Bearer ${memberToken}` } })).statusCode).toBe(403);
    await app.close();
  });

  it('allows admins to create members but only owners to create admins', async () => {
    const app = await buildApp({ db });
    const ownerToken = await setupOwner(app);
    await app.inject({
      method: 'POST', url: '/api/v1/users', headers: { authorization: `Bearer ${ownerToken}` },
      payload: { email: 'admin@example.com', displayName: 'Admin', password: 'admin-secret-1', role: 'admin' },
    });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@example.com', password: 'admin-secret-1' } });
    const adminToken = login.json().token as string;
    expect((await app.inject({
      method: 'POST', url: '/api/v1/users', headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: 'other-admin@example.com', displayName: 'Other Admin', password: 'admin-secret-2', role: 'admin' },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'POST', url: '/api/v1/users', headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: 'member@example.com', displayName: 'Member', password: 'member-secret-1', role: 'member' },
    })).statusCode).toBe(201);
    await app.close();
  });
});
