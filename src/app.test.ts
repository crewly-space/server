import { openSqlite, type Database } from './db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('buildApp', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('responds to GET /api/v1/health', async () => {
    const app = await buildApp({ db });
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
