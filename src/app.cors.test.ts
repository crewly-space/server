import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from './app.js';
import { openSqlite, type Database } from './db/driver.js';
import { runMigrations } from './db/migrate.js';

const APP_ORIGIN = 'https://app.crewly.space';

describe('cross-origin access for the hosted app', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('answers a trusted origin', async () => {
    const app = await buildApp({ db, trustedAppOrigins: [APP_ORIGIN] });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      headers: { origin: APP_ORIGIN },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    // Echoing one origin of several means the answer varies by it.
    expect(response.headers.vary).toContain('Origin');
    await app.close();
  });

  it('answers a preflight with the methods and headers the SDK uses', async () => {
    const app = await buildApp({ db, trustedAppOrigins: [APP_ORIGIN] });
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/agents',
      headers: {
        origin: APP_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    await app.close();
  });

  it('gives an untrusted origin nothing to read the answer with', async () => {
    const app = await buildApp({ db, trustedAppOrigins: [APP_ORIGIN] });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      headers: { origin: 'https://attacker.example' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('allows no cross-origin caller at all by default', async () => {
    const app = await buildApp({ db });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      headers: { origin: APP_ORIGIN },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('lets the trusted app onto the websocket, and turns another origin away', async () => {
    const app = await buildApp({ db, trustedAppOrigins: [APP_ORIGIN] });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || address === null) throw new Error('expected AddressInfo');
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const url = `ws://127.0.0.1:${address.port}/api/v1/ws?token=${setup.json().token}`;

    // The handshake succeeds either way -- the server accepts the upgrade and
    // then decides -- so the close code is what says whether it was let in.
    const closeCode = (origin: string): Promise<number> =>
      new Promise((resolve) => {
        const socket = new WebSocket(url, { origin });
        socket.once('open', () => socket.close());
        socket.once('close', (code) => resolve(code));
      });

    expect(await closeCode(APP_ORIGIN)).not.toBe(4003);
    expect(await closeCode('https://attacker.example')).toBe(4003);
    await app.close();
  });
});
