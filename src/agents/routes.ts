import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentRoutingModeSchema, AvatarModeSchema, ModelPolicySchema } from '../protocol/index.js';
import { requireAuth } from '../auth/middleware.js';
import {
  clearAgentRoutingOverride,
  createAgent,
  getAgent,
  getAgentRouting,
  listAgentsForOwner,
  setAgentAvailability,
  setAgentRoutingMode,
  updateAgent,
} from './repository.js';
import { listDelegates, setDelegates } from '../runtime/delegation.js';
import { getProviderConfig } from '../providers/repository.js';
import { getChannel } from '../channels/repository.js';
import type { Role } from '../users/repository.js';

const DelegatesBodySchema = z.object({ agentIds: z.array(z.string().min(1)).max(50) });

const AvailabilityBodySchema = z.object({ availability: z.enum(['auto', 'dnd']) });

const RoutingBodySchema = z.object({
  mode: z.union([AgentRoutingModeSchema, z.literal('inherit')]),
  conversationId: z.string().min(1).nullable().default(null),
});

const CreateAgentBodySchema = z.object({
  name: z.string().min(1),
  personality: z.string().default(''),
  modelPolicy: ModelPolicySchema,
  avatarMode: AvatarModeSchema.optional(),
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
      avatarMode: body.avatarMode,
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

  /** Every agent's canonical status: presence, what it is doing, and why. */
  app.get('/api/v1/agents/status', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send({ statuses: app.agentStatus.all() });
  });

  app.get('/api/v1/agents/:id/status', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const status = app.agentStatus.status(id);
    if (!status) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    reply.send(status);
  });

  /** Do Not Disturb, or back to automatic. The agent's owner or an admin may set it. */
  app.put('/api/v1/agents/:id/availability', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = AvailabilityBodySchema.parse(request.body);
    const agent = getAgent(app.db, id);
    if (!agent) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const role = request.user!.role;
    if (agent.ownerUserId !== request.user!.id && role !== 'owner' && role !== 'admin') {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    setAgentAvailability(app.db, id, body.availability);
    app.agentStatus.refresh(id);
    reply.send(app.agentStatus.status(id));
  });

  /** Global routing, with an optional channel-specific override. */
  app.get('/api/v1/agents/:id/routing', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = getAgent(app.db, id);
    if (!agent) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const role = request.user!.role;
    if (agent.ownerUserId !== request.user!.id && role !== 'owner' && role !== 'admin') {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    reply.send(getAgentRouting(app.db, id));
  });

  app.put('/api/v1/agents/:id/routing', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = RoutingBodySchema.parse(request.body);
    const agent = getAgent(app.db, id);
    if (!agent) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const role = request.user!.role;
    if (agent.ownerUserId !== request.user!.id && role !== 'owner' && role !== 'admin') {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    if (body.conversationId !== null) {
      const channel = getChannel(app.db, body.conversationId, { id: request.user!.id, role: role as Role });
      if (!channel) {
        reply.code(404).send({ error: 'channel_not_found' });
        return;
      }
      if (body.mode === 'inherit') {
        reply.send(clearAgentRoutingOverride(app.db, id, body.conversationId));
        return;
      }
    } else if (body.mode === 'inherit') {
      reply.code(400).send({ error: 'global_routing_requires_mode' });
      return;
    }
    reply.send(setAgentRoutingMode(app.db, id, body.mode, body.conversationId, request.user!.id));
  });

  /** Who this agent may hand subtasks to. */
  app.get('/api/v1/agents/:id/delegates', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getAgent(app.db, id)) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    reply.send({ delegates: listDelegates(app.db, id).map(({ id: agentId, name }) => ({ agentId, name })) });
  });

  app.put('/api/v1/agents/:id/delegates', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = DelegatesBodySchema.parse(request.body);
    const agent = getAgent(app.db, id);
    if (!agent) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const role = request.user!.role;
    if (agent.ownerUserId !== request.user!.id && role !== 'owner' && role !== 'admin') {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    if (body.agentIds.includes(id)) {
      reply.code(400).send({ error: 'cannot_delegate_to_self' });
      return;
    }
    const unknown = body.agentIds.filter((agentId) => !getAgent(app.db, agentId));
    if (unknown.length) {
      reply.code(400).send({ error: 'unknown_agents', agentIds: unknown });
      return;
    }
    setDelegates(app.db, id, body.agentIds);
    reply.send({ delegates: listDelegates(app.db, id).map(({ id: agentId, name }) => ({ agentId, name })) });
  });
}
