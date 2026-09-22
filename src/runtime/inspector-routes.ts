import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentRunStatusSchema, type AgentRun } from '../protocol/index.js';
import { requireAuth } from '../auth/middleware.js';
import { isParticipant } from '../conversations/repository.js';
import type { ConnectionHub } from '../ws/hub.js';
import { buildRunTrace } from './inspector.js';
import { appendRunEvent, cancelAgentRun, findRunForMessage, getAgentRun, listAgentRuns, listAgentRunsForRoot } from './runs.js';

const ListRunsQuerySchema = z.object({
  status: AgentRunStatusSchema.optional(),
  agentId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

function isAdmin(request: FastifyRequest): boolean {
  return request.user!.role === 'owner' || request.user!.role === 'admin';
}

/** A run is visible to whoever can see its conversation, and to the people who run the server. */
function canSee(app: FastifyInstance, request: FastifyRequest, run: AgentRun): boolean {
  return isAdmin(request) || isParticipant(app.db, run.conversationId, request.user!.id, 'user');
}

/** The runs a cancellation reaches: this one, and everything it started, however deep. */
function descendantsOf(app: FastifyInstance, run: AgentRun): AgentRun[] {
  const chain = listAgentRunsForRoot(app.db, run.rootRunId);
  const reached = new Set([run.runId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of chain) {
      if (candidate.causationId && reached.has(candidate.causationId) && !reached.has(candidate.runId)) {
        reached.add(candidate.runId);
        grew = true;
      }
    }
  }
  return chain.filter((candidate) => reached.has(candidate.runId));
}

export function registerRunInspectorRoutes(app: FastifyInstance, hub: ConnectionHub): void {
  /**
   * Runs, newest first. Admins can list any; anyone else lists the runs of a
   * conversation they are in, which is what the chat needs.
   */
  app.get('/api/v1/runs', { preHandler: requireAuth }, async (request, reply) => {
    const query = ListRunsQuerySchema.parse(request.query);
    if (!isAdmin(request)) {
      if (!query.conversationId || !isParticipant(app.db, query.conversationId, request.user!.id, 'user')) {
        reply.code(403).send({ error: 'forbidden' });
        return;
      }
    }
    reply.send({ runs: listAgentRuns(app.db, query) });
  });

  app.get('/api/v1/runs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = getAgentRun(app.db, id);
    // Not 403: a run in a conversation somebody is not part of is not theirs to know about.
    if (!run || !canSee(app, request, run)) {
      reply.code(404).send({ error: 'run_not_found' });
      return;
    }
    reply.send(buildRunTrace(app.db, run));
  });

  /** From a message in the chat to the run that wrote it (or that it started). */
  app.get('/api/v1/messages/:id/run', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = findRunForMessage(app.db, id);
    if (!run || !canSee(app, request, run)) {
      reply.code(404).send({ error: 'run_not_found' });
      return;
    }
    reply.send(buildRunTrace(app.db, run));
  });

  /**
   * Stops a run and everything it delegated. A run already talking to a
   * provider finishes that call, but its answer is discarded rather than posted.
   */
  app.post('/api/v1/runs/:id/cancel', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = getAgentRun(app.db, id);
    if (!run || !canSee(app, request, run)) {
      reply.code(404).send({ error: 'run_not_found' });
      return;
    }
    const cancelled: string[] = [];
    for (const target of descendantsOf(app, run)) {
      if (!cancelAgentRun(app.db, target.runId, `cancelled by ${request.user!.id}`)) continue;
      cancelled.push(target.runId);
      appendRunEvent(app.db, target.runId, 'run.cancel_requested', { by: request.user!.id, from: run.runId });
      hub.publish(`conversation:${target.conversationId}`, 'agent.run.finished', {
        runId: target.runId, rootRunId: target.rootRunId, agentId: target.agentId,
        conversationId: target.conversationId, status: 'cancelled',
      });
    }
    reply.send({ cancelled });
  });
}
