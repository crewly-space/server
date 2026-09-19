import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ModelPolicySchema } from '../protocol/index.js';
import { requireAuth } from '../auth/middleware.js';
import { createAgent, listAgentsForOwner, updateAgent } from './repository.js';
import { getProviderConfig } from '../providers/repository.js';

const CreateAgentBodySchema = z.object({
  name: z.string().min(1),
  personality: z.string().default(''),
  modelPolicy: ModelPolicySchema,
});

export function registerAgentRoutes(app: FastifyInstance): void {
  app.post('/api/v1/agents', { preHandler: requireAuth }, async (request, reply) => {
    const body = CreateAgentBodySchema.parse(request.body);
    if (!getProviderConfig(app.db, body.modelPolicy.defaultProviderId)) {
      reply.code(409).send({ error: 'provider_not_configured' });
      return;
    }
    const agent = createAgent(app.db, {
      ownerUserId: request.user!.id,
      name: body.name,
      personality: body.personality,
      modelPolicy: body.modelPolicy,
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    reply.code(201).send(agent);
  });

  app.get('/api/v1/agents', { preHandler: requireAuth }, async (request, reply) => {
    reply.send(listAgentsForOwner(app.db, request.user!.id));
  });
  app.patch('/api/v1/agents/:id', { preHandler: requireAuth }, async (request, reply) => {
    const body = CreateAgentBodySchema.parse(request.body);
    if (!getProviderConfig(app.db, body.modelPolicy.defaultProviderId)) {
      reply.code(409).send({ error: 'provider_not_configured' });
      return;
    }
    const { id } = request.params as { id: string };
    const agent = updateAgent(app.db, id, request.user!.id, body);
    if (!agent) { reply.code(404).send({ error: 'agent_not_found' }); return; }
    reply.send(agent);
  });
}
