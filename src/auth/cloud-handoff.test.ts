import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createUser, getUserByEmail, setUserSuspended } from '../users/repository.js';
import { hashPassword } from './password.js';

const DEPLOYMENT_ID = '6f1b1a2c-6f2a-4b5e-9c3d-2f6a7b8c9d01';

const keyPair = generateKeyPairSync('ed25519');
const cloudPublicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

interface Claims {
  deploymentId: string;
  cloudUserId: string;
  email: string;
  displayName: string;
  avatarMode?: 'bloop' | 'blobatar' | 'name';
  orgRole: 'owner' | 'admin' | 'member';
  nonce: string;
  iat: number;
  exp: number;
}

function token(overrides: Partial<Claims> = {}, key: KeyObject = keyPair.privateKey): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: Claims = {
    deploymentId: DEPLOYMENT_ID,
    cloudUserId: 'c0ffee00-0000-4000-8000-000000000001',
    email: 'buyer@example.com',
    displayName: 'Buyer',
    orgRole: 'owner',
    nonce: Math.random().toString(36).slice(2).padEnd(16, 'x'),
    iat: issuedAt,
    exp: issuedAt + 120,
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `v1.${payload}.${sign(null, Buffer.from(`v1.${payload}`), key).toString('base64url')}`;
}

describe('cloud handoff', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  const handoffApp = () =>
    buildApp({ db, cloudHandoff: { publicKey: cloudPublicKey, deploymentId: DEPLOYMENT_ID } });

  it('creates the first owner and returns a session', async () => {
    const app = await handoffApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/cloud-handoff',
      payload: { token: token() },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({ email: 'buyer@example.com', role: 'owner' });

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${response.json().token}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().email).toBe('buyer@example.com');
    await app.close();
  });

  it('returns the same account on a second handoff rather than a second owner', async () => {
    const app = await handoffApp();
    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/cloud-handoff', payload: { token: token() } });
    const second = await app.inject({ method: 'POST', url: '/api/v1/auth/cloud-handoff', payload: { token: token() } });
    expect(second.statusCode).toBe(201);
    expect(second.json().user.id).toBe(first.json().user.id);
    expect((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(1);
    await app.close();
  });

  it('joins a later arrival with the role Cloud gives them', async () => {
    const app = await handoffApp();
    await app.inject({ method: 'POST', url: '/api/v1/auth/cloud-handoff', payload: { token: token() } });
    const member = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/cloud-handoff',
      payload: {
        token: token({
          cloudUserId: 'c0ffee00-0000-4000-8000-000000000002',
          email: 'colleague@example.com',
          displayName: 'Colleague',
          orgRole: 'member',
        }),
      },
    });
    expect(member.statusCode).toBe(201);
    expect(member.json().user.role).toBe('member');
    await app.close();
  });

  it('never lowers a role that the server already granted', async () => {
    const app = await handoffApp();
    const owner = await app.inject({ method: 'POST', url: '/api/v1/auth/cloud-handoff', payload: { token: token() } });
    const demoted = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/cloud-handoff',
      payload: { token: token({ orgRole: 'member', displayName: 'Renamed Buyer', avatarMode: 'name' }) },
    });
    expect(demoted.json().user.id).toBe(owner.json().user.id);
    expect(demoted.json().user.role).toBe('owner');
    expect(getUserByEmail(db, 'buyer@example.com')).toMatchObject({ display_name: 'Renamed Buyer', avatar_mode: 'name' });
    await app.close();
  });

  it('links to an account that already has the same email', async () => {
    createUser(db, {
      email: 'buyer@example.com',
      displayName: 'Buyer',
      passwordHash: hashPassword('a-password-they-chose'),
      role: 'admin',
    });
    const app = await handoffApp();
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/cloud-handoff', payload: { token: token() } });
    expect(response.statusCode).toBe(201);
    expect((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(1);
    // The local password still works: a handoff links an account, it does not
    // take it over.
    expect(getUserByEmail(db, 'buyer@example.com')!.password_hash).not.toBeNull();
    await app.close();
  });

  it('tells a suspended account so instead of handing it a session', async () => {
    const app = await handoffApp();
    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/cloud-handoff', payload: { token: token() } });
    setUserSuspended(db, first.json().user.id, true);
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/cloud-handoff', payload: { token: token() } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'account_suspended' });
    expect((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
    await app.close();
  });

  it('refuses a token signed by somebody else', async () => {
    const stranger = generateKeyPairSync('ed25519');
    const app = await handoffApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/cloud-handoff',
      payload: { token: token({}, stranger.privateKey) },
    });
    expect(response.statusCode).toBe(401);
    expect((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(0);
    await app.close();
  });

  it('refuses a token minted for a different server', async () => {
    const app = await handoffApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/cloud-handoff',
      payload: { token: token({ deploymentId: '11111111-2222-4333-8444-555555555555' }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('refuses an expired token', async () => {
    const app = await handoffApp();
    const past = Math.floor(Date.now() / 1000) - 600;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/cloud-handoff',
      payload: { token: token({ iat: past, exp: past + 120 }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('refuses a token whose lifetime is longer than Cloud is allowed to mint', async () => {
    const app = await handoffApp();
    const issuedAt = Math.floor(Date.now() / 1000);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/cloud-handoff',
      payload: { token: token({ iat: issuedAt, exp: issuedAt + 86_400 }) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('refuses a replayed token', async () => {
    const app = await handoffApp();
    const replayed = token();
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/cloud-handoff', payload: { token: replayed } })).statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/cloud-handoff', payload: { token: replayed } });
    expect(again.statusCode).toBe(401);
    await app.close();
  });

  it('refuses a tampered payload', async () => {
    const app = await handoffApp();
    const [version, payload, signature] = token().split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.email = 'attacker@example.com';
    const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/cloud-handoff',
      payload: { token: `${version}.${forged}.${signature}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('does not exist on a server that is not linked to Cloud', async () => {
    const app = await buildApp({ db });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/cloud-handoff',
      payload: { token: token() },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('reports the link in the setup status, so the app knows how to sign in', async () => {
    const linked = await handoffApp();
    expect((await linked.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toMatchObject({
      cloudHandoff: true,
    });
    await linked.close();

    const standalone = await buildApp({ db });
    expect((await standalone.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toMatchObject({
      cloudHandoff: false,
    });
    await standalone.close();
  });
});
