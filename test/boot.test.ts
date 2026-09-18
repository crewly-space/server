import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';

describe('full boot sequence', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('boots against a real on-disk SQLite database and serves the first-admin flow', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrew-boot-'));
    const db = openDatabase(dataDir);
    const applied = runMigrations(db);
    expect(applied.length).toBeGreaterThan(0);

    const app = await buildApp({ db });

    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    expect(setup.statusCode).toBe(201);

    await app.close();
    db.close();
  });
});
