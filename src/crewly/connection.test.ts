import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { crewlyServiceCredential } from './connection.js';

/**
 * Just enough of Crewly's instance API to link, check, rotate and revoke,
 * with the owner's side (approve, change scopes, revoke) as plain methods.
 */
class FakeCrewly {
  approved = false;
  denied = false;
  scopes: string[] = [];
  credential: string | null = null;
  version = 0;
  unreachable = false;
  readonly calls: string[] = [];

  fetch: typeof fetch = async (input, init) => {
    if (this.unreachable) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
    const instance = () => ({ id: 'inst-1', scopes: [...this.scopes].sort(), credentialVersion: this.version });

    if (url.pathname === '/api/v1/instances/link') {
      const body = JSON.parse(String(init!.body));
      this.scopes = body.scopes;
      return json(201, { deviceCode: 'device-secret', userCode: 'BCDF-GHJK', verificationUrlComplete: 'https://crewly.test/#/connect/BCDF-GHJK', expiresIn: 600, interval: 5 });
    }
    if (url.pathname === '/api/v1/instances/link/token') {
      if (this.denied) return json(400, { error: 'access_denied' });
      if (!this.approved) return json(400, { error: 'authorization_pending' });
      this.version = 1;
      this.credential = 'crewly_inst_one';
      return json(201, { instance: instance(), credential: this.credential });
    }
    if (this.deleted && url.pathname.startsWith('/api/v1/instance')) return json(404, { error: 'Instance not found' });
    if (!this.credential || auth !== `Bearer ${this.credential}`) return json(401, { error: 'Instance credential is not valid' });
    if (url.pathname === '/api/v1/instance' && method === 'GET') return json(200, { instance: instance() });
    if (url.pathname === '/api/v1/instance' && method === 'DELETE') {
      this.credential = null;
      return json(204);
    }
    if (url.pathname === '/api/v1/instance/credential') {
      this.version += 1;
      this.credential = `crewly_inst_v${this.version}`;
      return json(200, { instance: instance(), credential: this.credential });
    }
    return json(404, { error: 'not found' });
  };

  revoke(): void {
    this.credential = null;
  }

  /** The instance was deleted in Crewly: every instance call now answers 404. */
  deleted = false;
}

describe('Connect Crewly', () => {
  let db: Database;
  let crewly: FakeCrewly;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: { authorization: string };
  let member: { authorization: string };

  beforeEach(async () => {
    db = openSqlite(':memory:');
    runMigrations(db);
    crewly = new FakeCrewly();
    app = await buildApp({ db, fetchImpl: crewly.fetch, crewlyCloudUrl: 'https://crewly.test' });
    const ownerUser = createUser(db, { email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'owner' });
    const memberUser = createUser(db, { email: 'm@example.com', displayName: 'M', passwordHash: 'x', role: 'member' });
    owner = { authorization: `Bearer ${createSession(db, ownerUser.id)}` };
    member = { authorization: `Bearer ${createSession(db, memberUser.id)}` };
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const connect = async (scopes = ['mail:send']) => {
    const started = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/connect', headers: owner, payload: { name: 'home', scopes } });
    expect(started.statusCode).toBe(200);
    crewly.approved = true;
    const polled = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/connect/poll', headers: owner });
    expect(polled.json().status).toBe('connected');
    return polled.json();
  };

  it('connects from settings with a code the owner approves in Crewly', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/connect', headers: owner, payload: { name: 'home', scopes: ['mail:send'] } });
    expect(started.json()).toMatchObject({
      status: 'pending',
      link: { userCode: 'BCDF-GHJK', verificationUrl: 'https://crewly.test/#/connect/BCDF-GHJK', interval: 5 },
    });

    const waiting = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/connect/poll', headers: owner });
    expect(waiting.json().status).toBe('pending');

    crewly.approved = true;
    const done = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/connect/poll', headers: owner });
    expect(done.json()).toMatchObject({ status: 'connected', instanceId: 'inst-1', scopes: ['mail:send'], credentialVersion: 1, link: null });

    // The credential never leaves the server, and is encrypted where it rests.
    const status = await app.inject({ method: 'GET', url: '/api/v1/server/crewly', headers: owner });
    expect(JSON.stringify(status.json())).not.toContain('crewly_inst_one');
    const stored = db.prepare('SELECT credential_ciphertext FROM crewly_connection').pluck().get() as string;
    expect(stored).toMatch(/^enc:v1:/);
    expect(crewlyServiceCredential(db, 'mail:send')).toEqual({ cloudUrl: 'https://crewly.test', instanceId: 'inst-1', credential: 'crewly_inst_one' });
    expect(crewlyServiceCredential(db, 'inference')).toBeUndefined();
  });

  it('forgets a link the owner denied', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/server/crewly/connect', headers: owner, payload: {} });
    crewly.denied = true;
    const denied = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/connect/poll', headers: owner });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().message).toBe('The link was denied in Crewly');
    expect((await app.inject({ method: 'GET', url: '/api/v1/server/crewly', headers: owner })).json().status).toBe('disconnected');
  });

  it('picks up scope changes made in Crewly without reconnecting', async () => {
    await connect(['mail:send']);
    crewly.scopes = ['inference', 'mail:send'];
    const refreshed = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/refresh', headers: owner });
    expect(refreshed.json().scopes).toEqual(['inference', 'mail:send']);
    expect(crewlyServiceCredential(db, 'inference')?.instanceId).toBe('inst-1');
  });

  it('rotates the credential and keeps the same instance', async () => {
    await connect();
    const rotated = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/credential/rotate', headers: owner });
    expect(rotated.json()).toMatchObject({ status: 'connected', instanceId: 'inst-1', credentialVersion: 2 });
    expect(crewlyServiceCredential(db, 'mail:send')?.credential).toBe('crewly_inst_v2');
  });

  it('notices a revocation in Crewly and stops offering the credential', async () => {
    await connect();
    crewly.revoke();
    const refreshed = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/refresh', headers: owner });
    expect(refreshed.json()).toMatchObject({ status: 'revoked', scopes: [] });
    expect(crewlyServiceCredential(db, 'mail:send')).toBeUndefined();
    expect(db.prepare('SELECT credential_ciphertext FROM crewly_connection').pluck().get()).toBeNull();
  });

  it('treats an instance deleted in Crewly as a stale link to reconnect, not an error', async () => {
    await connect();
    crewly.deleted = true;
    const refreshed = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/refresh', headers: owner });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ status: 'revoked', scopes: [] });
    expect(crewlyServiceCredential(db, 'mail:send')).toBeUndefined();
    // The stale local record can then be removed outright.
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/server/crewly', headers: owner });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/server/crewly', headers: owner })).json().status).toBe('disconnected');
  });

  it('disconnects locally even when Crewly cannot be reached, and touches nothing else', async () => {
    await connect();
    const users = db.prepare('SELECT COUNT(*) FROM users').pluck().get();
    crewly.unreachable = true;
    const gone = await app.inject({ method: 'DELETE', url: '/api/v1/server/crewly', headers: owner });
    expect(gone.json()).toEqual({ notifiedCrewly: false });
    expect((await app.inject({ method: 'GET', url: '/api/v1/server/crewly', headers: owner })).json().status).toBe('disconnected');
    expect(db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(users);
  });

  it('tells Crewly when disconnecting, so the credential dies there too', async () => {
    await connect();
    const gone = await app.inject({ method: 'DELETE', url: '/api/v1/server/crewly', headers: owner });
    expect(gone.json()).toEqual({ notifiedCrewly: true });
    expect(crewly.calls).toContain('DELETE /api/v1/instance');
  });

  it('refuses a second connection while one is live', async () => {
    await connect();
    const again = await app.inject({ method: 'POST', url: '/api/v1/server/crewly/connect', headers: owner, payload: {} });
    expect(again.statusCode).toBe(409);
  });

  it('is for owners and admins only', async () => {
    for (const [method, url] of [['GET', '/api/v1/server/crewly'], ['POST', '/api/v1/server/crewly/connect'], ['DELETE', '/api/v1/server/crewly']] as const) {
      expect((await app.inject({ method, url, headers: member, payload: method === 'GET' ? undefined : {} })).statusCode).toBe(403);
    }
  });

  it('audits every change without the credential or device code', async () => {
    await connect(['mail:send']);
    crewly.scopes = ['inference'];
    await app.inject({ method: 'POST', url: '/api/v1/server/crewly/refresh', headers: owner });
    await app.inject({ method: 'POST', url: '/api/v1/server/crewly/credential/rotate', headers: owner });
    await app.inject({ method: 'DELETE', url: '/api/v1/server/crewly', headers: owner });
    const audit = await app.inject({ method: 'GET', url: '/api/v1/server/crewly/audit', headers: owner });
    const entries = audit.json().entries as { action: string }[];
    expect(entries.map((entry) => entry.action).reverse()).toEqual(['link_started', 'connected', 'scopes_changed', 'credential_rotated', 'disconnected']);
    const serialized = JSON.stringify(entries);
    for (const secret of ['crewly_inst_one', 'crewly_inst_v2', 'device-secret']) expect(serialized).not.toContain(secret);
  });
});
