import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openSqlite } from '../src/db/driver.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
it('refreshes the shell, caches hashed assets and refuses missing scripts instead of serving HTML', async () => {
  const root = mkdtempSync(join(tmpdir(), 'crewly-web-'));
  mkdirSync(join(root, 'assets')); writeFileSync(join(root, 'index.html'), '<main>Crewly</main>');
  writeFileSync(join(root, 'assets', 'app-hash.js'), 'console.log("app")'); writeFileSync(join(root, 'sw.js'), '// worker');
  const db = openSqlite(':memory:'); runMigrations(db);
  const app = await buildApp({ db, webDir: root });
  try {
    for (const url of ['/', '/join', '/sw.js']) expect((await app.inject({ url })).headers['cache-control']).toBe('no-store');
    expect((await app.inject({ url: '/assets/app-hash.js' })).headers['cache-control']).toContain('immutable');
    expect((await app.inject({ url: '/assets/missing.js' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/missing' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/join' })).body).toContain('Crewly');
  } finally { await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
