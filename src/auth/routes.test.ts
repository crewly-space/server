import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';

describe('auth routes', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('allows the first /api/v1/auth/setup call and rejects the second with 409', async () => {
    const app = await buildApp({ db });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().token).toBeTypeOf('string');
    expect(first.json().user.role).toBe('owner');

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'other@example.com', displayName: 'Other', password: 'super-secret-2' },
    });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it('requires and consumes the one-time claim token when configured', async () => {
    const onSetupComplete = vi.fn();
    const app = await buildApp({ db, setupClaimToken: 'one-time-claim-token', onSetupComplete });
    const status = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(status.json()).toEqual({ initialized: false, claimRequired: true, cloudHandoff: false });

    const denied = await app.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1', claimToken: 'wrong' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'invalid_claim_token' });
    expect(onSetupComplete).not.toHaveBeenCalled();

    const claimed = await app.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1', claimToken: 'one-time-claim-token' },
    });
    expect(claimed.statusCode).toBe(201);
    expect(onSetupComplete).toHaveBeenCalledOnce();
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/status' })).json()).toEqual({ initialized: true, claimRequired: false, cloudHandoff: false });
    await app.close();
  });

  it('logs in with correct credentials and rejects incorrect ones', async () => {
    const app = await buildApp({ db });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });

    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@example.com', password: 'wrong-password' },
    });
    expect(badLogin.statusCode).toBe(401);

    const goodLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@example.com', password: 'super-secret-1' },
    });
    expect(goodLogin.statusCode).toBe(200);
    expect(goodLogin.json().token).toBeTypeOf('string');

    const caseInsensitiveLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'OWNER@EXAMPLE.COM', password: 'super-secret-1' },
    });
    expect(caseInsensitiveLogin.statusCode).toBe(200);

    await app.close();
  });

  it('returns 400 with invalid_request for an invalid login body', async () => {
    const app = await buildApp({ db });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-an-email', password: 'x' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('invalid_request');
    expect(Array.isArray(body.issues)).toBe(true);

    await app.close();
  });

  it('requires a valid bearer token for /api/v1/auth/me', async () => {
    const app = await buildApp({ db });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const { token } = setup.json();

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(unauthenticated.statusCode).toBe(401);

    const authenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json().email).toBe('owner@example.com');

    await app.close();
  });
});
