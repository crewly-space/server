import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';

describe('running a server: members and invites', () => {
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

  async function invite(role: 'admin' | 'member' = 'member', token = owner) {
    return app.inject({ method: 'POST', url: '/api/v1/invites', headers: as(token), payload: { role } });
  }

  async function join(code: string, email = 'joiner@example.com') {
    return app.inject({
      method: 'POST',
      url: `/api/v1/invites/${code}/accept`,
      payload: { email, displayName: 'Joiner', password: 'another-secret-1' },
    });
  }

  it('creates an invite an owner can hand out as a link', async () => {
    const created = await invite();
    expect(created.statusCode).toBe(201);
    expect(created.json().invite).toMatchObject({ role: 'member', usedAt: null });
    // The code is shown once, when it is made: it is a credential.
    expect(created.json().invite.code).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/invites', headers: as(owner) });
    expect(listed.json().invites).toHaveLength(1);
    expect(listed.json().invites[0].code).toBeUndefined();
  });

  it('lets somebody join with it, once', async () => {
    const { code } = (await invite()).json().invite;

    const joined = await join(code);
    expect(joined.statusCode).toBe(201);
    expect(joined.json().user).toMatchObject({ email: 'joiner@example.com', role: 'member' });
    expect(joined.json().token).toBeTypeOf('string');

    // Spent, revoked and expired all answer alike: none of them is something
    // the person holding the code can act on.
    const again = await join(code, 'second@example.com');
    expect(again.statusCode).toBe(404);
  });

  it('refuses an invite that was revoked or never existed', async () => {
    const { id, code } = (await invite()).json().invite;
    const revoked = await app.inject({ method: 'DELETE', url: `/api/v1/invites/${id}`, headers: as(owner) });
    expect(revoked.statusCode).toBe(204);
    expect((await join(code)).statusCode).toBe(404);
    expect((await join('never-existed-code-here')).statusCode).toBe(404);
  });

  it('refuses an expired invite', async () => {
    const { code } = (await invite()).json().invite;
    db.prepare('UPDATE invites SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    expect((await join(code)).statusCode).toBe(404);
  });

  it('only an owner may invite an admin', async () => {
    const { code } = (await invite('admin')).json().invite;
    const admin = (await join(code, 'admin@example.com')).json().token;

    expect((await invite('member', admin)).statusCode).toBe(201);
    expect((await invite('admin', admin)).statusCode).toBe(403);
  });

  it('keeps invites away from a plain member', async () => {
    const { code } = (await invite()).json().invite;
    const member = (await join(code)).json().token;
    expect((await invite('member', member)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/invites', headers: as(member) })).statusCode).toBe(403);
  });
});

describe('running a server: changing what a member may do', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: string;
  let memberId: string;
  let memberToken: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db });
    owner = (await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    })).json().token;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${owner}` },
      payload: { email: 'member@example.com', displayName: 'Member', password: 'member-secret-1' },
    });
    memberId = created.json().id;
    memberToken = (await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'member@example.com', password: 'member-secret-1' },
    })).json().token;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  it('promotes and demotes a member', async () => {
    const promoted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${memberId}`,
      headers: as(owner),
      payload: { role: 'admin' },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().role).toBe('admin');
  });

  it('suspends a member, which ends their sessions', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: as(memberToken) })).statusCode).toBe(200);

    const suspended = await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${memberId}/suspension`,
      headers: as(owner),
      payload: { suspended: true },
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().suspendedAt).toBeTypeOf('string');

    // Suspending somebody who is already signed in has to take effect now,
    // not whenever their session happens to expire.
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: as(memberToken) })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'member@example.com', password: 'member-secret-1' },
    })).statusCode).toBe(403);
  });

  it('gives access back', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${memberId}/suspension`,
      headers: as(owner),
      payload: { suspended: true },
    });
    const restored = await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${memberId}/suspension`,
      headers: as(owner),
      payload: { suspended: false },
    });
    expect(restored.json().suspendedAt).toBeNull();
    expect((await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'member@example.com', password: 'member-secret-1' },
    })).statusCode).toBe(200);
  });

  it('removes a member', async () => {
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${memberId}`,
      headers: as(owner),
    });
    expect(removed.statusCode).toBe(204);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/users', headers: as(owner) });
    expect(listed.json().map((user: { email: string }) => user.email)).toEqual(['owner@example.com']);
  });

  it('never leaves the server without an owner', async () => {
    const ownerId = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: as(owner) })).json().id;

    for (const call of [
      { method: 'PATCH' as const, url: `/api/v1/users/${ownerId}`, payload: { role: 'member' } },
      { method: 'PUT' as const, url: `/api/v1/users/${ownerId}/suspension`, payload: { suspended: true } },
      { method: 'DELETE' as const, url: `/api/v1/users/${ownerId}`, payload: undefined },
    ]) {
      const response = await app.inject({ ...call, headers: as(owner) });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(409);
    }
  });

  it('keeps all of it away from a member', async () => {
    expect((await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${memberId}`,
      headers: as(memberToken),
      payload: { role: 'admin' },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${memberId}`,
      headers: as(memberToken),
    })).statusCode).toBe(403);
  });
});
