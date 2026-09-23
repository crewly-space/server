import type { Database } from './db/driver.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 30 * DAY_MS;
/** Usage is kept long enough to compare this month with the same one last year. */
const USAGE_RETENTION_MS = 400 * DAY_MS;

export interface PruneResult {
  events: number;
  jobs: number;
  sessions: number;
  providerCalls: number;
  mailDeliveries: number;
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
  const providerCalls = db.prepare('DELETE FROM provider_calls WHERE created_at < ?')
    .run(new Date(now.getTime() - Math.max(retentionMs, USAGE_RETENTION_MS)).toISOString());
  // Finished deliveries only; one still retrying keeps its row.
  const mailDeliveries = db.prepare("DELETE FROM mail_deliveries WHERE status IN ('sent', 'failed') AND created_at < ?").run(cutoff);
  return {
    events: Number(events.changes),
    jobs: Number(jobs.changes),
    sessions: Number(sessions.changes),
    providerCalls: Number(providerCalls.changes),
    mailDeliveries: Number(mailDeliveries.changes),
  };
}
