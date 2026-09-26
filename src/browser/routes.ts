import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { hasPermission } from '../permissions/roles.js';

export function registerBrowserRoutes(app: FastifyInstance): void {
  app.get('/api/v1/browser/sessions', { preHandler: requireAuth }, async (request, reply) => {
    if (!hasPermission(app.db, request.user!.id, 'operations.view')) { reply.code(403).send({ error: 'operations_view_required' }); return; }
    const sessions = app.db.prepare(`SELECT id, run_id AS runId, agent_id AS agentId, status, persistent, page_count AS pageCount,
      created_at AS createdAt, expires_at AS expiresAt, closed_at AS closedAt, last_error AS lastError
      FROM browser_sessions ORDER BY created_at DESC LIMIT 200`).all();
    reply.send({ sessions });
  });
  app.get('/api/v1/browser/sessions/:id/actions', { preHandler: requireAuth }, async (request, reply) => {
    if (!hasPermission(app.db, request.user!.id, 'operations.view')) { reply.code(403).send({ error: 'operations_view_required' }); return; }
    const actions = app.db.prepare(`SELECT id, action, url, status, artifact_id AS artifactId, duration_ms AS durationMs, created_at AS createdAt
      FROM browser_actions WHERE session_id = ? ORDER BY created_at`).all((request.params as { id: string }).id);
    reply.send({ actions });
  });
}
