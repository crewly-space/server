import type { Database } from './db/driver.js';

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface PruneResult {
  events: number;
  jobs: number;
  sessions: number;
}

export function pruneOperationalData(
  db: Database,
  now: Date = new Date(),
  retentionMs = DEFAULT_RETENTION_MS,
): PruneResult {
  const cutoff = new Date(now.getTime() - retentionMs).toISOString();
  const events = db.prepare('DELETE FROM event_log WHERE created_at < ?').run(cutoff);
  const jobs = db.prepare(
    "DELETE FROM jobs WHERE status IN ('done', 'failed') AND updated_at < ?"
  ).run(cutoff);
  const sessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  return {
    events: Number(events.changes),
    jobs: Number(jobs.changes),
    sessions: Number(sessions.changes),
  };
}
