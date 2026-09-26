import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getAgent } from '../agents/repository.js';
import { hasPermission } from './roles.js';
import {
  EXECUTION_CAPABILITIES,
  listCapabilityPolicies,
  replaceCapabilityPolicies,
  type CapabilityDecision,
  type CapabilityScope,
  type ExecutionCapability,
} from './capabilities.js';

const PolicySchema = z.object({
  capability: z.enum(EXECUTION_CAPABILITIES),
  decision: z.enum(['allow', 'ask', 'deny']),
  scope: z.record(z.string(), z.union([z.string().max(2048), z.array(z.string().max(2048)).max(100)])).default({}),
});
const BodySchema = z.object({ policies: z.array(PolicySchema).max(100) });

function permitted(app: FastifyInstance, userId: string): boolean {
  return hasPermission(app.db, userId, 'agents.manage');
}

export function registerCapabilityPolicyRoutes(app: FastifyInstance): void {
  app.get('/api/v1/capability-policies', { preHandler: requireAuth }, async (request, reply) => {
    if (!permitted(app, request.user!.id)) { reply.code(403).send({ error: 'agents_manage_required' }); return; }
    const query = z.object({ agentId: z.string().min(1).optional() }).parse(request.query);
    reply.send({ capabilities: EXECUTION_CAPABILITIES, policies: listCapabilityPolicies(app.db, query.agentId) });
  });

  app.put('/api/v1/capability-policies/defaults', { preHandler: requireAuth }, async (request, reply) => {
    if (!permitted(app, request.user!.id)) { reply.code(403).send({ error: 'agents_manage_required' }); return; }
    const body = BodySchema.parse(request.body);
    reply.send({ policies: replaceCapabilityPolicies(app.db, null, body.policies as Array<{ capability: ExecutionCapability; decision: CapabilityDecision; scope: CapabilityScope }>, request.user!.id) });
  });

  app.put('/api/v1/agents/:id/capability-policies', { preHandler: requireAuth }, async (request, reply) => {
    if (!permitted(app, request.user!.id)) { reply.code(403).send({ error: 'agents_manage_required' }); return; }
    const { id } = request.params as { id: string };
    if (!getAgent(app.db, id)) { reply.code(404).send({ error: 'agent_not_found' }); return; }
    const body = BodySchema.parse(request.body);
    reply.send({ policies: replaceCapabilityPolicies(app.db, id, body.policies as Array<{ capability: ExecutionCapability; decision: CapabilityDecision; scope: CapabilityScope }>, request.user!.id) });
  });
}
