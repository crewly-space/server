import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { enqueueJob } from './repository.js';
import { JobRunner } from './runner.js';

describe('JobRunner', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('runOnce executes a due job with its registered handler and marks it done', async () => {
    const handler = vi.fn(async () => {});
    const runner = new JobRunner(db, { greet: handler });
    enqueueJob(db, { type: 'greet', payload: { name: 'world' } });

    const ran = await runner.runOnce();

    expect(ran).toBe(true);
    expect(handler).toHaveBeenCalledWith(db, { name: 'world' });
    const row = db.prepare("SELECT status FROM jobs WHERE type = 'greet'").get() as { status: string };
    expect(row.status).toBe('done');
  });

  it('runOnce returns false when no job is due', async () => {
    const runner = new JobRunner(db, {});
    expect(await runner.runOnce()).toBe(false);
  });

  it('runOnce schedules a retry when its handler throws, without crashing', async () => {
    const runner = new JobRunner(db, {
      boom: async () => {
        throw new Error('handler exploded');
      },
    });
    enqueueJob(db, { type: 'boom', payload: {} });

    await expect(runner.runOnce()).resolves.toBe(true);
    const row = db.prepare("SELECT status, last_error FROM jobs WHERE type = 'boom'").get() as {
      status: string;
      last_error: string;
    };
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('handler exploded');
  });

  it('runOnce marks a job failed when no handler is registered for its type', async () => {
    const runner = new JobRunner(db, {});
    enqueueJob(db, { type: 'unknown-type', payload: {} });

    await runner.runOnce();
    const row = db.prepare("SELECT status, last_error FROM jobs WHERE type = 'unknown-type'").get() as {
      status: string;
      last_error: string;
    };
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('no handler registered');
  });
});
