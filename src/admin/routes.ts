import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import type { Database } from '../db/driver.js';

const LogQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const BrandingInputSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  tagline: z.string().trim().max(160).optional(),
  iconDataUrl: z.union([
    z.string()
      .max(350_000)
      .regex(/^data:image\/(?:png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+=*$/, 'icon must be a base64 PNG, JPEG or SVG data URL'),
    z.null(),
  ]).optional(),
});

/** One line of what has gone wrong lately, in the order it happened. */
export interface LogEntry {
  kind: 'job_failed' | 'agent_run_failed';
  at: string;
  subject: string;
  detail: string;
  /** For a failed run: the run to open in the inspector. */
  runId?: string;
}

const count = (db: Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { count: number }).count;

function canAdminister(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function brandingView(db: Database) {
  const row = db.prepare('SELECT display_name, tagline, icon_data_url, updated_at FROM server_branding WHERE id = 1').get() as
    | { display_name: string; tagline: string; icon_data_url: string | null; updated_at: string }
    | undefined;
  return {
    displayName: row?.display_name ?? 'Crewly',
    tagline: row?.tagline ?? '',
    iconDataUrl: row?.icon_data_url ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * What the people who run a server need to see about it.
 *
 * Deliberately counts rather than a metrics system: a self-hosted Crewly is
 * one process and one SQLite file, and the questions worth answering here --
 * how much is in it, is anything stuck, what failed -- are all answerable from
 * that file.
 */
export function registerServerAdminRoutes(app: FastifyInstance, options: { version: string }): void {
  const startedAt = Date.now();

  app.get('/api/v1/server/branding', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send(brandingView(app.db));
  });

  app.patch('/api/v1/server/branding', { preHandler: requireAuth }, async (request, reply) => {
    if (!canAdminister(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const input = BrandingInputSchema.parse(request.body);
    const current = brandingView(app.db);
    app.db.prepare(
      `UPDATE server_branding
       SET display_name = ?, tagline = ?, icon_data_url = ?, updated_at = ?
       WHERE id = 1`,
    ).run(
      input.displayName ?? current.displayName,
      input.tagline ?? current.tagline,
      input.iconDataUrl === undefined ? current.iconDataUrl : input.iconDataUrl,
      new Date().toISOString(),
    );
    reply.send(brandingView(app.db));
  });

  app.get('/api/v1/server/status', { preHandler: requireAuth }, async (request, reply) => {
    if (!canAdminister(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const db = app.db;
    reply.send({
      version: options.version,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      usage: {
        users: count(db, 'SELECT COUNT(*) AS count FROM users'),
        agents: count(db, 'SELECT COUNT(*) AS count FROM agents'),
        conversations: count(db, 'SELECT COUNT(*) AS count FROM conversations'),
        messages: count(db, 'SELECT COUNT(*) AS count FROM messages'),
        providers: count(db, 'SELECT COUNT(*) AS count FROM provider_configs'),
        devices: count(db, 'SELECT COUNT(*) AS count FROM devices'),
      },
      jobs: {
        pending: count(db, "SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending'"),
        failed: count(db, "SELECT COUNT(*) AS count FROM jobs WHERE status = 'failed'"),
      },
      approvals: {
        pending: count(db, "SELECT COUNT(*) AS count FROM approvals WHERE status = 'pending'"),
      },
    });
  });

  /**
   * Recent failures, newest first.
   *
   * Not the process log: that belongs to whoever runs the container. This is
   * the part somebody administering the server can act on -- a job that keeps
   * failing, an agent run that did not finish -- without reading a terminal.
   */
  app.get('/api/v1/server/logs', { preHandler: requireAuth }, async (request, reply) => {
    if (!canAdminister(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { limit } = LogQuerySchema.parse(request.query);
    const rows = app.db
      .prepare(
        `SELECT type AS subject, last_error AS detail, updated_at AS at
         FROM jobs
         WHERE status = 'failed' AND last_error IS NOT NULL
         ORDER BY updated_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(limit) as { subject: string; detail: string; at: string }[];

    const runs = app.db
      .prepare(
        `SELECT r.run_id AS runId, COALESCE(a.name, r.agent_id) AS subject,
                COALESCE(r.error_code || ': ', '') || COALESCE(r.error_message, 'failed') AS detail,
                COALESCE(r.finished_at, r.created_at) AS at
         FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id
         WHERE r.status = 'failed'
         ORDER BY at DESC LIMIT ?`,
      )
      .all(limit) as { runId: string; subject: string; detail: string; at: string }[];

    const entries: LogEntry[] = [
      ...rows.map((row): LogEntry => ({ kind: 'job_failed', at: row.at, subject: row.subject, detail: row.detail })),
      // Each failed run links to its trace, so the dashboard can open the inspector.
      ...runs.map((row): LogEntry => ({ kind: 'agent_run_failed', at: row.at, subject: row.subject, detail: row.detail, runId: row.runId })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
    reply.send({ entries });
  });
}
