import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { resolveDatabaseSecretKey } from '../db/secrets.js';
import { createUser } from '../users/repository.js';
import {
  createSecret,
  findSecretReferences,
  readSecretFor,
  registerSecretReferenceScanner,
  resolveSecretReferences,
  SecretAccessError,
  setSecretGrants,
} from './vault.js';

let admin = { type: 'user' as const, id: 'admin' };
const server = { type: 'mcp_server' as const, id: 'github' };

describe('secrets vault', () => {
  let db: Database;
  beforeEach(() => {
    db = openSqlite(':memory:');
    runMigrations(db);
    admin = { type: 'user', id: createUser(db, { email: 'a@example.com', displayName: 'A', passwordHash: 'x', role: 'owner' }).id };
  });
  afterEach(() => db.close());

  it('stores the value encrypted and never hands it back as metadata', () => {
    const secret = createSecret(db, { name: 'GITHUB_TOKEN', value: 'ghp_live_value' }, admin);
    expect(JSON.stringify(secret)).not.toContain('ghp_live_value');
    const stored = db.prepare('SELECT ciphertext FROM secrets').pluck().get() as string;
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain('ghp_live_value');
  });

  it('gives a value only to what it was granted to, and records each read', () => {
    const secret = createSecret(db, { name: 'GITHUB_TOKEN', value: 'ghp_live_value' }, admin);
    expect(() => readSecretFor(db, 'GITHUB_TOKEN', server)).toThrow('secret GITHUB_TOKEN has not been granted to this mcp server');

    setSecretGrants(db, secret.id, [server], admin);
    expect(readSecretFor(db, 'GITHUB_TOKEN', server)).toBe('ghp_live_value');
    expect(() => readSecretFor(db, 'GITHUB_TOKEN', { type: 'agent', id: 'someone-else' })).toThrow(SecretAccessError);

    const actions = db.prepare('SELECT action, actor_type, actor_id FROM secret_audit ORDER BY rowid').all();
    expect(actions).toEqual([
      { action: 'created', actor_type: 'user', actor_id: admin.id },
      { action: 'granted', actor_type: 'user', actor_id: admin.id },
      { action: 'accessed', actor_type: 'mcp_server', actor_id: 'github' },
    ]);
  });

  it('fills references in configuration, for a grantee holding every one', () => {
    const secret = createSecret(db, { name: 'API_KEY', value: 'k-123' }, admin);
    setSecretGrants(db, secret.id, [server], admin);
    expect(findSecretReferences('Bearer {{secret:API_KEY}} and {{ secret:API_KEY }}')).toEqual(['API_KEY']);
    expect(resolveSecretReferences(db, 'Bearer {{secret:API_KEY}}', server)).toBe('Bearer k-123');
    expect(() => resolveSecretReferences(db, '{{secret:MISSING}}', server)).toThrow('secret MISSING does not exist');
  });

  it('refuses a revoked secret until it is rotated back in', () => {
    const secret = createSecret(db, { name: 'TOKEN', value: 'one' }, admin);
    setSecretGrants(db, secret.id, [server], admin);
    db.prepare('UPDATE secrets SET ciphertext = NULL, revoked_at = ? WHERE id = ?').run(new Date().toISOString(), secret.id);
    expect(() => readSecretFor(db, 'TOKEN', server)).toThrow('secret TOKEN has been revoked');
  });
});

describe('secrets routes', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken: string;
  let memberToken: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db });
    ownerToken = createSession(db, createUser(db, { email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'owner' }).id);
    memberToken = createSession(db, createUser(db, { email: 'm@example.com', displayName: 'M', passwordHash: 'x', role: 'member' }).id);
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const create = (name = 'GITHUB_TOKEN', value = 'ghp_live_value') =>
    app.inject({ method: 'POST', url: '/api/v1/secrets', headers: as(ownerToken), payload: { name, value, description: 'CI' } });

  it('is closed to members', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/secrets', headers: as(memberToken) })).statusCode).toBe(403);
    const attempt = await app.inject({
      method: 'POST', url: '/api/v1/secrets', headers: as(memberToken), payload: { name: 'X', value: 'y' },
    });
    expect(attempt.statusCode).toBe(403);
  });

  it('creates, lists, renames and rotates without ever returning a value', async () => {
    const created = await create();
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const list = await app.inject({ method: 'GET', url: '/api/v1/secrets', headers: as(ownerToken) });
    expect(list.json().secrets).toMatchObject([{ name: 'GITHUB_TOKEN', description: 'CI', version: 1, revoked: false }]);

    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/secrets/${id}`, headers: as(ownerToken), payload: { name: 'GH_TOKEN' } });
    expect(renamed.json().name).toBe('GH_TOKEN');

    const rotated = await app.inject({ method: 'PUT', url: `/api/v1/secrets/${id}/value`, headers: as(ownerToken), payload: { value: 'ghp_next' } });
    expect(rotated.json()).toMatchObject({ version: 2 });
    expect(rotated.json().rotatedAt).toBeTruthy();

    const revoked = await app.inject({ method: 'POST', url: `/api/v1/secrets/${id}/revoke`, headers: as(ownerToken) });
    expect(revoked.json()).toMatchObject({ revoked: true });

    for (const response of [created, list, renamed, rotated, revoked]) {
      expect(response.body).not.toContain('ghp_');
    }
    const audit = await app.inject({ method: 'GET', url: `/api/v1/secrets/audit?secretId=${id}`, headers: as(ownerToken) });
    expect(audit.json().entries.map((e: { action: string }) => e.action)).toEqual(['revoked', 'rotated', 'renamed', 'created']);
  });

  it('insists on names configuration can refer to', async () => {
    expect((await create('github token')).statusCode).toBe(400);
    expect((await create()).statusCode).toBe(201);
    expect((await create()).statusCode).toBe(409);
  });

  it('says what a delete would break before breaking it', async () => {
    const id = (await create()).json().id;
    await app.inject({
      method: 'PUT', url: `/api/v1/secrets/${id}/grants`, headers: as(ownerToken),
      payload: { grants: [{ type: 'mcp_server', id: 'github' }, { type: 'agent', id: 'agent-1' }] },
    });

    const refused = await app.inject({ method: 'DELETE', url: `/api/v1/secrets/${id}`, headers: as(ownerToken) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().dependents).toEqual([
      { type: 'agent', id: 'agent-1', name: 'agent-1', via: 'grant' },
      { type: 'mcp_server', id: 'github', name: 'github', via: 'grant' },
    ]);

    const forced = await app.inject({ method: 'DELETE', url: `/api/v1/secrets/${id}?force=true`, headers: as(ownerToken) });
    expect(forced.statusCode).toBe(204);
    // The history outlives the secret.
    const audit = await app.inject({ method: 'GET', url: '/api/v1/secrets/audit', headers: as(ownerToken) });
    expect(audit.json().entries[0]).toMatchObject({ action: 'deleted', secretName: 'GITHUB_TOKEN' });
  });

  it('refuses a rename that would orphan a reference, unless forced', async () => {
    const id = (await create('REFERENCED')).json().id;
    registerSecretReferenceScanner((_db, name) =>
      name === 'REFERENCED' ? [{ type: 'skill', id: 's1', name: 'Deploy', via: 'reference' }] : []);
    const refused = await app.inject({ method: 'PATCH', url: `/api/v1/secrets/${id}`, headers: as(ownerToken), payload: { name: 'OTHER' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().dependents).toEqual([{ type: 'skill', id: 's1', name: 'Deploy', via: 'reference' }]);
    const forced = await app.inject({ method: 'PATCH', url: `/api/v1/secrets/${id}?force=true`, headers: as(ownerToken), payload: { name: 'OTHER' } });
    expect(forced.statusCode).toBe(200);
  });
});

describe('managed secrets key', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-key-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('uses the platform key without writing it to disk', () => {
    const key = randomBytes(32);
    expect(resolveDatabaseSecretKey(dir, key.toString('base64')).equals(key)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'secrets.key'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'secrets.key.managed'), 'utf8')).not.toContain(key.toString('base64'));
  });

  it('refuses to start without the managed key once it has been used', () => {
    resolveDatabaseSecretKey(dir, randomBytes(32).toString('base64'));
    expect(() => resolveDatabaseSecretKey(dir)).toThrow(/set CREWLY_SECRETS_KEY/);
  });

  it('refuses a different managed key than the one secrets were written with', () => {
    resolveDatabaseSecretKey(dir, randomBytes(32).toString('base64'));
    expect(() => resolveDatabaseSecretKey(dir, randomBytes(32).toString('base64'))).toThrow(/not the key/);
  });

  it('refuses a managed key that does not match an existing local one', () => {
    resolveDatabaseSecretKey(dir);
    expect(() => resolveDatabaseSecretKey(dir, randomBytes(32).toString('base64'))).toThrow(/secrets\.key/);
  });

  it('keeps generating a local key for a self-hosted server', () => {
    const first = resolveDatabaseSecretKey(dir);
    expect(resolveDatabaseSecretKey(dir).equals(first)).toBe(true);
  });
});
