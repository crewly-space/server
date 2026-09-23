import type { Database } from '../db/driver.js';
import { administrators, emitNotification } from '../notifications/service.js';
import { claimNextJob, completeJob, failJob, recoverStaleJobs } from './repository.js';

export type JobHandler = (db: Database, payload: unknown) => Promise<void>;

export class JobRunner {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private db: Database,
    private handlers: Record<string, JobHandler>,
    private intervalMs = 5000
  ) {}

  async runOnce(): Promise<boolean> {
    const job = claimNextJob(this.db);
    if (!job) return false;
    const handler = this.handlers[job.type];
    if (!handler) {
      failJob(this.db, job.id, `no handler registered for job type "${job.type}"`, { retry: false });
      return true;
    }
    try {
      await handler(this.db, job.payload);
      completeJob(this.db, job.id);
    } catch (err) {
      failJob(this.db, job.id, (err as Error).message);
      // Out of retries: somebody running the server has to look.
      if (this.db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(job.id) === 'failed') {
        void emitNotification(this.db, {
          type: 'server.alert',
          recipients: administrators(this.db),
          dedupeKey: `job-failed:${job.id}`,
          collapseKey: `job:${job.type}`,
          title: `Background work failed: ${job.type}`,
          body: (err as Error).message.slice(0, 280),
        });
      }
    }
    return true;
  }

  start(): void {
    if (this.timer) return;
    recoverStaleJobs(this.db);
    this.timer = setInterval(() => {
      this.runOnce().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
