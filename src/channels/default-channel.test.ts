import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { createSession } from '../auth/session.js';
import { createUser } from '../users/repository.js';
import { applyHandoff } from '../auth/cloud-handoff.js';
import { ensureDefaultChannel } from './repository.js';

describe('a new server opens on #general', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  it('creates a public #general when the first owner is set up, readable and joinable by members', async () => {
    const app = await buildApp({ db });
    const setup = await app.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const owner = setup.json().token as string;
    const channels = await app.inject({ method: 'GET', url: '/api/v1/channels', headers: { authorization: `Bearer ${owner}` } });
    expect(channels.json().channels.map((c: { name: string; visibility: string; joined: boolean }) => [c.name, c.visibility, c.joined]))
      .toEqual([['general', 'public', true]]);

    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const member = createSession(db, bob.id);
    const seen = await app.inject({ method: 'GET', url: '/api/v1/channels', headers: { authorization: `Bearer ${member}` } });
    const general = seen.json().channels[0];
    expect(general).toMatchObject({ name: 'general', joined: false });
    const join = await app.inject({
      method: 'POST', url: `/api/v1/channels/${general.id}/join`, headers: { authorization: `Bearer ${member}` },
    });
    expect(join.statusCode).toBeLessThan(300);
    await app.close();
  });

  it('opens #general for the owner who arrives from Cloud, and only once', () => {
    applyHandoff(db, { cloudUserId: 'cu_1', email: 'owner@example.com', orgRole: 'member' } as never);
    applyHandoff(db, { cloudUserId: 'cu_2', email: 'second@example.com', orgRole: 'member' } as never);
    const rows = db.prepare("SELECT name FROM conversations WHERE kind = 'channel'").all();
    expect(rows).toEqual([{ name: 'general' }]);
  });

  it('never brings #general back once a server has any channel', () => {
    const owner = createUser(db, { email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'owner' });
    expect(ensureDefaultChannel(db, { id: owner.id, role: 'owner' })?.name).toBe('general');
    expect(ensureDefaultChannel(db, { id: owner.id, role: 'owner' })).toBeUndefined();
  });
});
