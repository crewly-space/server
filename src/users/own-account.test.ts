import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { buildApp } from '../app.js';

describe('a person changing their own email and password', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let ownerId: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db });
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' } });
    token = setup.json().token;
    ownerId = setup.json().user.id;
  });
  afterEach(async () => { await app.close(); db.close(); });

  const as = (bearer: string) => ({ authorization: `Bearer ${bearer}` });
  const login = (email: string, password: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

  it('changes the email once the current password confirms it, and signs in with the new one', async () => {
    const wrong = await app.inject({ method: 'PUT', url: '/api/v1/users/me/email', headers: as(token), payload: { email: 'new@example.com', currentPassword: 'not-it' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toBe('wrong_password');

    const changed = await app.inject({ method: 'PUT', url: '/api/v1/users/me/email', headers: as(token), payload: { email: ' New@Example.com ', currentPassword: 'super-secret-1' } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ id: ownerId, email: 'new@example.com' });
    expect((await login('new@example.com', 'super-secret-1')).statusCode).toBe(200);
    expect((await login('owner@example.com', 'super-secret-1')).statusCode).not.toBe(200);
  });

  it('refuses an email another account on the server already uses', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/users', headers: as(token), payload: { email: 'taken@example.com', displayName: 'Taken', password: 'another-secret-1' } });
    const taken = await app.inject({ method: 'PUT', url: '/api/v1/users/me/email', headers: as(token), payload: { email: 'taken@example.com', currentPassword: 'super-secret-1' } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('email_taken');
  });

  it('leaves the email of a Crewly-only account to Crewly', async () => {
    db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(ownerId);
    db.prepare("INSERT INTO external_identities (provider, subject, user_id, created_at) VALUES ('crewly-cloud', 'cloud-1', ?, ?)").run(ownerId, new Date().toISOString());
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: as(token) })).json();
    expect(me).toMatchObject({ hasPassword: false, signsInWithCrewly: true });
    const refused = await app.inject({ method: 'PUT', url: '/api/v1/users/me/email', headers: as(token), payload: { email: 'new@example.com', currentPassword: 'x' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('email_managed_by_crewly');
  });

  it('changes the password and signs out the other sessions, keeping this one', async () => {
    const other = (await login('owner@example.com', 'super-secret-1')).json().token as string;
    const changed = await app.inject({ method: 'PUT', url: '/api/v1/users/me/password', headers: as(token), payload: { currentPassword: 'super-secret-1', newPassword: 'even-better-secret-2' } });
    expect(changed.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: as(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: as(other) })).statusCode).toBe(401);
    expect((await login('owner@example.com', 'even-better-secret-2')).statusCode).toBe(200);
  });
});
