import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { claimNextJob, completeJob, enqueueJob, failJob, recoverStaleJobs } from './repository.js';

describe('jobs repository', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('enqueues and claims a due job', () => {
    enqueueJob(db, { type: 'noop', payload: { x: 1 } });
    const claimed = claimNextJob(db);
    expect(claimed?.type).toBe('noop');
    expect(claimed?.status).toBe('running');
    expect(claimed?.payload).toEqual({ x: 1 });
  });

  it('does not claim a job scheduled in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    enqueueJob(db, { type: 'noop', payload: {}, runAt: future });
    expect(claimNextJob(db)).toBeUndefined();
  });

  it('collapses duplicate pending enqueues sharing a dedupeKey', () => {
    enqueueJob(db, { type: 'summarize', payload: { conversationId: 'c1' }, dedupeKey: 'summarize:c1' });
    enqueueJob(db, { type: 'summarize', payload: { conversationId: 'c1' }, dedupeKey: 'summarize:c1' });
    const row = db.prepare("SELECT COUNT(*) as n FROM jobs WHERE status = 'pending'").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('allows a fresh enqueue with the same dedupeKey once the prior job is running', () => {
    enqueueJob(db, { type: 'summarize', payload: { conversationId: 'c1' }, dedupeKey: 'summarize:c1' });
    claimNextJob(db);
    enqueueJob(db, { type: 'summarize', payload: { conversationId: 'c1' }, dedupeKey: 'summarize:c1' });
    const row = db.prepare("SELECT COUNT(*) as n FROM jobs WHERE status = 'pending'").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('completeJob marks a job done', () => {
    enqueueJob(db, { type: 'noop', payload: {} });
    const claimed = claimNextJob(db)!;
    completeJob(db, claimed.id);
    const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(claimed.id) as { status: string };
    expect(row.status).toBe('done');
  });

  it('failJob retries with backoff, records the error, and increments attempts', () => {
    enqueueJob(db, { type: 'noop', payload: {} });
    const claimed = claimNextJob(db)!;
    const now = new Date('2026-01-01T00:00:00.000Z');
    failJob(db, claimed.id, 'boom', { now, baseDelayMs: 1_000 });
    const row = db.prepare('SELECT status, attempts, last_error, run_at FROM jobs WHERE id = ?').get(claimed.id) as {
      status: string;
      attempts: number;
      last_error: string;
      run_at: string;
    };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('boom');
    expect(row.run_at).toBe('2026-01-01T00:00:01.000Z');
  });

  it('marks a job terminal after the maximum number of failed attempts', () => {
    enqueueJob(db, { type: 'noop', payload: {} });
    const claimed = claimNextJob(db)!;
    db.prepare('UPDATE jobs SET attempts = 2 WHERE id = ?').run(claimed.id);
    failJob(db, claimed.id, 'still broken', { now: new Date('2026-01-01T00:00:00.000Z') });
    const row = db.prepare('SELECT status, attempts FROM jobs WHERE id = ?').get(claimed.id) as { status: string; attempts: number };
    expect(row).toEqual({ status: 'failed', attempts: 3 });
  });

  it('recovers jobs abandoned by a stopped server', () => {
    enqueueJob(db, { type: 'noop', payload: {} });
    const claimed = claimNextJob(db)!;
    db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', claimed.id);
    expect(recoverStaleJobs(db, new Date('2026-01-01T00:10:00.000Z'))).toBe(1);
    const row = db.prepare('SELECT status, attempts, last_error FROM jobs WHERE id = ?').get(claimed.id) as {
      status: string; attempts: number; last_error: string;
    };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('server stopped');
  });
});
