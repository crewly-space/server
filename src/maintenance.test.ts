import { openSqlite, type Database } from './db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './db/migrate.js';
import { pruneOperationalData } from './maintenance.js';

describe('operational maintenance', () => {
  let db: Database;
  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  it('prunes old events, finished jobs, and expired sessions while preserving live rows', () => {
    const old = '2025-01-01T00:00:00.000Z';
    const recent = '2026-01-09T00:00:00.000Z';
    db.prepare('INSERT INTO event_log (topic, type, payload, created_at) VALUES (?, ?, ?, ?)').run('old', 'x', '{}', old);
    db.prepare('INSERT INTO event_log (topic, type, payload, created_at) VALUES (?, ?, ?, ?)').run('recent', 'x', '{}', recent);
    db.prepare(`INSERT INTO jobs (id, type, payload, status, attempts, last_error, dedupe_key, run_at, created_at, updated_at)
      VALUES (?, 'x', '{}', ?, 0, NULL, NULL, ?, ?, ?)`).run('old-done', 'done', old, old, old);
    db.prepare(`INSERT INTO jobs (id, type, payload, status, attempts, last_error, dedupe_key, run_at, created_at, updated_at)
      VALUES (?, 'x', '{}', ?, 0, NULL, NULL, ?, ?, ?)`).run('old-pending', 'pending', old, old, old);
    db.prepare('INSERT INTO users (id, email, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u1', 'u1@example.test', 'U1', 'x', 'member', old);
    db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run('expired', 'u1', old, old);
    db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run('live', 'u1', recent, '2027-01-01T00:00:00.000Z');

    const call = db.prepare(
      `INSERT INTO provider_calls (id, provider_id, provider_kind, model, purpose, attempt, status, latency_ms, created_at)
       VALUES (?, 'p', 'anthropic', 'm', 'agent_turn', 1, 'ok', 1, ?)`,
    );
    call.run('over-a-year', '2024-11-01T00:00:00.000Z');
    call.run('last-month', '2025-12-10T00:00:00.000Z');

    expect(pruneOperationalData(db, new Date('2026-01-10T00:00:00.000Z'), 24 * 60 * 60 * 1000)).toEqual({
      events: 1, jobs: 1, sessions: 1, providerCalls: 1, mailDeliveries: 0,
    });
    // Usage outlives the operational retention: budgets and reports need it.
    expect(db.prepare('SELECT id FROM provider_calls').pluck().all()).toEqual(['last-month']);
    expect((db.prepare('SELECT topic FROM event_log').pluck().all())).toEqual(['recent']);
    expect((db.prepare('SELECT id FROM jobs').pluck().all())).toEqual(['old-pending']);
    expect((db.prepare('SELECT token FROM sessions').pluck().all())).toEqual(['live']);
  });
});
