import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAgent } from '../agents/repository.js';
import { requireAuth } from '../auth/middleware.js';
import { getConversation, isParticipant } from '../conversations/repository.js';
import type { Role } from '../permissions/model.js';
import { createMemoryFact, deleteMemoryFact, getMemoryFact, listMemoryFactsForAgent, updateMemoryFact } from './repository.js';
import { getConversationSummary } from './summary-repository.js';

const CreateMemoryFactBodySchema = z.object({
  content: z.string().min(1),
  source: z.enum(['conversation', 'manual', 'summary']).default('manual'),
  tags: z.array(z.string()).default([]),
});

const UpdateMemoryFactBodySchema = z.object({
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
});

function canManageAgentMemory(role: Role, requesterId: string, agentOwnerId: string): boolean {
  // Intentional: admin/owner is a site-wide trusted role in this self-host model,
  // same convention as group membership management in conversations/routes.ts.
  return requesterId === agentOwnerId || role === 'admin' || role === 'owner';
}

export function registerMemoryFactRoutes(app: FastifyInstance): void {
  app.post('/api/v1/agents/:agentId/memory-facts', { preHandler: requireAuth }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = getAgent(app.db, agentId);
    if (!agent) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    if (!canManageAgentMemory(request.user!.role as Role, request.user!.id, agent.ownerUserId)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const body = CreateMemoryFactBodySchema.parse(request.body);
    const { fact, created } = createMemoryFact(app.db, { agentId, content: body.content, source: body.source, tags: body.tags });
    reply.code(created ? 201 : 200).send(fact);
  });

  app.get('/api/v1/agents/:agentId/memory-facts', { preHandler: requireAuth }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = getAgent(app.db, agentId);
    if (!agent) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    if (!canManageAgentMemory(request.user!.role as Role, request.user!.id, agent.ownerUserId)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    reply.send(listMemoryFactsForAgent(app.db, agentId));
  });

  app.patch('/api/v1/agents/:agentId/memory-facts/:factId', { preHandler: requireAuth }, async (request, reply) => {
    const { agentId, factId } = request.params as { agentId: string; factId: string };
    const agent = getAgent(app.db, agentId);
    if (!agent) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    if (!canManageAgentMemory(request.user!.role as Role, request.user!.id, agent.ownerUserId)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const existing = getMemoryFact(app.db, factId);
    if (!existing || existing.agentId !== agentId) {
      reply.code(404).send({ error: 'memory_fact_not_found' });
      return;
    }
    const body = UpdateMemoryFactBodySchema.parse(request.body);
    reply.send(updateMemoryFact(app.db, factId, body));
  });

  app.delete('/api/v1/agents/:agentId/memory-facts/:factId', { preHandler: requireAuth }, async (request, reply) => {
    const { agentId, factId } = request.params as { agentId: string; factId: string };
    const agent = getAgent(app.db, agentId);
    if (!agent) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    if (!canManageAgentMemory(request.user!.role as Role, request.user!.id, agent.ownerUserId)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const existing = getMemoryFact(app.db, factId);
    if (!existing || existing.agentId !== agentId) {
      reply.code(404).send({ error: 'memory_fact_not_found' });
      return;
    }
    deleteMemoryFact(app.db, factId);
    reply.code(204).send();
  });
}

export function registerConversationSummaryRoutes(app: FastifyInstance): void {
  app.get('/api/v1/conversations/:id/summary', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = getConversation(app.db, id);
    if (!conversation) {
      reply.code(404).send({ error: 'conversation_not_found' });
      return;
    }
    if (!isParticipant(app.db, id, request.user!.id, 'user')) {
      reply.code(403).send({ error: 'not_a_participant' });
      return;
    }
    const summary = getConversationSummary(app.db, id);
    if (!summary) {
      reply.code(404).send({ error: 'summary_not_found' });
      return;
    }
    reply.send(summary);
  });
}
