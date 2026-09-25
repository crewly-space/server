import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { hasPermission } from '../permissions/roles.js';
import type { ConnectionHub } from '../ws/hub.js';
import type { RespondFn } from '../runtime/engine.js';
import type { AgentRunQueue } from '../runtime/queue.js';
import {
  createAutomation,
  deleteAutomation,
  dispatchAutomationEvent,
  getAutomation,
  listAutomationRuns,
  listAutomations,
  updateAutomation,
  verifyWebhookSecret,
  type AutomationAction,
  type AutomationInput,
} from './service.js';

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('post_message'), conversationId: z.string().min(1).optional(), body: z.string().trim().min(1).max(100_000) }),
  z.object({ type: z.literal('invoke_agent'), agentId: z.string().min(1), conversationId: z.string().min(1).optional(), prompt: z.string().trim().max(100_000).optional() }),
  z.object({ type: z.literal('call_webhook'), url: z.string().url().max(2048), method: z.enum(['POST', 'PUT']).optional(), body: z.unknown().optional() }),
]);
const BodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(240).optional(),
  enabled: z.boolean().optional(),
  triggerType: z.enum(['webhook', 'message', 'schedule', 'run']),
  triggerConfig: z.record(z.string(), z.unknown()).optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  actions: z.array(ActionSchema).min(1).max(20),
});

function allowed(app: FastifyInstance, userId: string): boolean {
  return hasPermission(app.db, userId, 'automations.manage');
}

export function registerAutomationRoutes(
  app: FastifyInstance,
  options: { publicUrl?: string; hub: ConnectionHub; respond: RespondFn; queue?: AgentRunQueue; fetchImpl?: typeof fetch },
): void {
  const baseUrl = options.publicUrl;
  const deps = () => ({
    db: app.db, hub: options.hub, respond: options.respond, queue: options.queue, fetchImpl: options.fetchImpl,
    automationDispatch: (event: { type: 'message' | 'run'; eventId: string; dedupeKey: string; payload: Record<string, unknown>; conversationId?: string; hopCount?: number }) => dispatchAutomationEvent(deps(), event),
  });
  const check = (request: { user?: { id: string } }, reply: { code: (status: number) => { send: (body: unknown) => void } }): boolean => {
    if (!request.user || !allowed(app, request.user.id)) { reply.code(403).send({ error: 'automations_manage_required' }); return false; }
    return true;
  };

  app.get('/api/v1/automations', { preHandler: requireAuth }, async (request, reply) => {
    if (!check(request, reply)) return;
    reply.send({ automations: listAutomations(app.db, baseUrl) });
  });

  app.post('/api/v1/automations', { preHandler: requireAuth }, async (request, reply) => {
    if (!check(request, reply)) return;
    const result = createAutomation(app.db, { ...BodySchema.parse(request.body), createdBy: request.user!.id } as AutomationInput & { createdBy: string });
    const automation = result.automation.triggerType === 'webhook' && baseUrl
      ? { ...result.automation, webhookEndpoint: `${baseUrl.replace(/\/$/, '')}/api/v1/automations/${result.automation.id}/webhook` }
      : result.automation;
    reply.code(201).send({ automation, webhookSecret: result.webhookSecret });
  });

  app.patch('/api/v1/automations/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!check(request, reply)) return;
    reply.send(updateAutomation(app.db, (request.params as { id: string }).id, BodySchema.parse(request.body) as AutomationInput));
  });

  app.delete('/api/v1/automations/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!check(request, reply)) return;
    if (!deleteAutomation(app.db, (request.params as { id: string }).id)) { reply.code(404).send({ error: 'automation_not_found' }); return; }
    reply.code(204).send();
  });

  app.get('/api/v1/automations/runs', { preHandler: requireAuth }, async (request, reply) => {
    if (!check(request, reply)) return;
    const query = request.query as { automationId?: string; limit?: string };
    reply.send({ runs: listAutomationRuns(app.db, query.automationId, Math.min(200, Math.max(1, Number(query.limit ?? 100)))) });
  });

  app.post('/api/v1/automations/:id/webhook', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const secret = request.headers['x-crewly-automation-secret'];
    if (typeof secret !== 'string' || !verifyWebhookSecret(app.db, id, secret)) { reply.code(404).send({ error: 'automation_not_found' }); return; }
    const body = (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) ? request.body as Record<string, unknown> : { value: request.body };
    const eventId = typeof request.headers['x-webhook-event-id'] === 'string' ? request.headers['x-webhook-event-id'] : typeof body.event_id === 'string' ? body.event_id : undefined;
    await dispatchAutomationEvent(deps(), { type: 'webhook', eventId, dedupeKey: eventId ?? JSON.stringify(body), payload: body });
    reply.code(202).send({ accepted: true });
  });

  app.post('/api/v1/automations/events/run', { preHandler: requireAuth }, async (request, reply) => {
    if (!check(request, reply)) return;
    const body = z.object({ eventId: z.string().min(1).max(200).optional(), dedupeKey: z.string().min(1).max(200), payload: z.record(z.string(), z.unknown()).default({}), conversationId: z.string().min(1).optional() }).parse(request.body);
    await dispatchAutomationEvent(deps(), { type: 'run', ...body });
    reply.code(202).send({ accepted: true });
  });
}
