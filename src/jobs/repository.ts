import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';

export interface JobRecord {
  id: string;
  type: string;
  payload: unknown;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
  runAt: string;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  last_error: string | null;
  run_at: string;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload),
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    runAt: row.run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function enqueueJob(
  db: Database,
  input: { type: string; payload: unknown; dedupeKey?: string; runAt?: string }
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO jobs (id, type, payload, status, attempts, last_error, dedupe_key, run_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?, ?, ?)`
  ).run(randomUUID(), input.type, JSON.stringify(input.payload), input.dedupeKey ?? null, input.runAt ?? now, now, now);
}

export function claimNextJob(db: Database, now: string = new Date().toISOString()): JobRecord | undefined {
  const claim = db.transaction((claimNow: string) => {
    const row = db
      .prepare(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC, rowid ASC LIMIT 1`)
      .get(claimNow) as JobRow | undefined;
    if (!row) return undefined;
    db.prepare(`UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'`).run(claimNow, row.id);
    return rowToJob({ ...row, status: 'running', updated_at: claimNow });
  });
  return claim(now);
}

export function completeJob(db: Database, id: string): void {
  db.prepare(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

export function failJob(
  db: Database,
  id: string,
  error: string,
  options: { retry?: boolean; maxAttempts?: number; now?: Date; baseDelayMs?: number } = {},
): void {
  const row = db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(id) as { attempts: number } | undefined;
  if (!row) return;
  const attempts = row.attempts + 1;
  const maxAttempts = options.maxAttempts ?? 3;
  const now = options.now ?? new Date();
  const shouldRetry = (options.retry ?? true) && attempts < maxAttempts;
  const delay = (options.baseDelayMs ?? 5_000) * (2 ** Math.max(0, attempts - 1));
  db.prepare(
    `UPDATE jobs SET status = ?, attempts = ?, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?`
  ).run(
    shouldRetry ? 'pending' : 'failed',
    attempts,
    error,
    shouldRetry ? new Date(now.getTime() + delay).toISOString() : now.toISOString(),
    now.toISOString(),
    id,
  );
}

/** Recovers work abandoned when the prior server process exited mid-handler. */
export function recoverStaleJobs(
  db: Database,
  now: Date = new Date(),
  staleAfterMs = 5 * 60_000,
): number {
  const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
  const result = db.prepare(
    `UPDATE jobs
     SET status = CASE WHEN attempts + 1 < 3 THEN 'pending' ELSE 'failed' END,
         attempts = attempts + 1,
         last_error = 'server stopped while job was running',
         run_at = ?,
         updated_at = ?
     WHERE status = 'running' AND updated_at <= ?`
  ).run(now.toISOString(), now.toISOString(), cutoff);
  return Number(result.changes);
}
