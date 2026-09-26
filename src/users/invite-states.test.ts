import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createSession } from '../auth/session.js';
import { createUser } from './repository.js';

describe('invite-first membership', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    owner = setup.json().token;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const invite = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/invites', headers: as(owner), payload });
  const statuses = async () =>
    (await app.inject({ method: 'GET', url: '/api/v1/invites', headers: as(owner) })).json().invites
      .map((i: { email: string | null; status: string }) => [i.email, i.status]);

  it('invites an email without anyone choosing a password for them, and says what the link is for', async () => {
    const created = await invite({ email: 'Sam@Example.com', role: 'member', send: false });
    expect(created.statusCode).toBe(201);
    expect(created.json().invite).toMatchObject({ email: 'sam@example.com', status: 'pending', role: 'member' });
    const preview = await app.inject({ method: 'GET', url: `/api/v1/invites/${created.json().invite.code}` });
    expect(preview.json()).toMatchObject({ role: 'member', email: 'sam@example.com' });
  });

  it('refuses a second invite for the same person, or for someone already here', async () => {
    await invite({ email: 'sam@example.com', send: false });
    const again = await invite({ email: 'SAM@example.com', send: false });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('invite_pending');
    const member = await invite({ email: 'owner@example.com', send: false });
    expect(member.statusCode).toBe(409);
    expect(member.json().error).toBe('already_member');
  });

  it('only lets the invited address accept', async () => {
    const { code } = (await invite({ email: 'sam@example.com', send: false })).json().invite;
    const wrong = await app.inject({
      method: 'POST', url: `/api/v1/invites/${code}/accept`,
      payload: { email: 'eve@example.com', displayName: 'Eve', password: 'another-secret-1' },
    });
    expect(wrong.statusCode).toBe(403);
    const right = await app.inject({
      method: 'POST', url: `/api/v1/invites/${code}/accept`,
      payload: { email: 'sam@example.com', displayName: 'Sam', password: 'another-secret-1' },
    });
    expect(right.statusCode).toBe(201);
    expect(right.json().user).toMatchObject({ email: 'sam@example.com', role: 'member' });
    expect(await statuses()).toEqual([['sam@example.com', 'accepted']]);
  });

  it('lets someone who already has an account accept by signing in, keeping their password', async () => {
    const existing = createUser(db, { email: 'lee@example.com', displayName: 'Lee', passwordHash: 'kept', role: 'member' });
    const session = createSession(db, existing.id);
    const { code } = (await invite({ role: 'admin' })).json().invite;
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/invites/${code}/accept`, headers: as(session) });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().user).toMatchObject({ email: 'lee@example.com', role: 'admin' });
    expect(db.prepare('SELECT password_hash FROM users WHERE id = ?').pluck().get(existing.id)).toBe('kept');
    expect((await app.inject({ method: 'POST', url: `/api/v1/invites/${code}/accept`, headers: as(session) })).statusCode).toBe(404);
  });

  it('never lowers the role of someone who accepts', async () => {
    const { code } = (await invite({ role: 'member' })).json().invite;
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/invites/${code}/accept`, headers: as(owner) });
    expect(accepted.json().user.role).toBe('owner');
  });

  it('keeps a revoked invite on the list as revoked, and it no longer works', async () => {
    const { id, code } = (await invite({ email: 'sam@example.com', send: false })).json().invite;
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/invites/${id}`, headers: as(owner) })).statusCode).toBe(204);
    expect(await statuses()).toEqual([['sam@example.com', 'revoked']]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/invites/${code}` })).statusCode).toBe(404);
    // Revoked is no longer pending, so the person can be invited afresh.
    expect((await invite({ email: 'sam@example.com', send: false })).statusCode).toBe(201);
  });

  it('shows an expired invite as expired, and resending gives a new working code', async () => {
    const { id, code } = (await invite({ email: 'sam@example.com', send: false })).json().invite;
    db.prepare('UPDATE invites SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    expect(await statuses()).toEqual([['sam@example.com', 'expired']]);
    const resent = await app.inject({ method: 'POST', url: `/api/v1/invites/${id}/resend`, headers: as(owner) });
    expect(resent.statusCode).toBe(200);
    expect(resent.json().invite.status).toBe('pending');
    expect(resent.json().invite.code).not.toBe(code);
    expect((await app.inject({ method: 'GET', url: `/api/v1/invites/${code}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/invites/${resent.json().invite.code}` })).statusCode).toBe(200);
  });

  it('will not resend or revoke an invite that was already accepted', async () => {
    const { id, code } = (await invite({ email: 'sam@example.com', send: false })).json().invite;
    await app.inject({
      method: 'POST', url: `/api/v1/invites/${code}/accept`,
      payload: { email: 'sam@example.com', displayName: 'Sam', password: 'another-secret-1' },
    });
    expect((await app.inject({ method: 'POST', url: `/api/v1/invites/${id}/resend`, headers: as(owner) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/invites/${id}`, headers: as(owner) })).statusCode).toBe(409);
  });
});
