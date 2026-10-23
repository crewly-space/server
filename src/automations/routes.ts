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
import { isParticipant } from '../conversations/repository.js';
import { getAgent } from '../agents/repository.js';
import { getProviderConfig } from '../providers/repository.js';
import { canReadChannel, blockedAgentIds } from '../channels/repository.js';
import { parsePublicHttpsUrl } from '../security/outbound.js';

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('post_message'), conversationId: z.string().min(1).optional(), body: z.string().trim().min(1).max(100_000) }),
  z.object({ type: z.literal('invoke_agent'), agentId: z.string().min(1), conversationId: z.string().min(1).optional(), prompt: z.string().trim().max(100_000).optional() }),
  z.object({ type: z.literal('call_webhook'), url: z.string().url().max(2048).refine((value) => {
    try { parsePublicHttpsUrl(value); return true; } catch { return false; }
  }, 'Webhook URL must use public HTTPS'), method: z.enum(['POST', 'PUT']).optional(), body: z.unknown().optional() }),
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

  // Conversation tools are available to ordinary members. Their saved tasks
  // need a matching, ownership-scoped UI API, not admin automation access.
  const canRead = (conversationId: string, userId: string) => isParticipant(app.db, conversationId, userId, 'user')
    || canReadChannel(app.db, conversationId, userId);
  const ownTasks = (conversationId: string, userId: string) => listAutomations(app.db).filter((rule) =>
    rule.createdBy === userId && rule.triggerConfig.kind === 'conversation_schedule'
    && rule.triggerConfig.conversationId === conversationId);
  const taskView = (rule: ReturnType<typeof listAutomations>[number]) => {
    const lastRun = listAutomationRuns(app.db, rule.id, 1)[0];
    return { id: rule.id, name: rule.name, enabled: rule.enabled, runAt: String(rule.triggerConfig.runAt),
      intervalMinutes: typeof rule.triggerConfig.intervalMinutes === 'number' ? rule.triggerConfig.intervalMinutes : null,
      agentId: String(rule.triggerConfig.agentId), kind: rule.triggerConfig.proactive === true ? 'followup' : rule.actions[0]?.type === 'invoke_agent' ? 'task' : 'reminder',
      ...(rule.triggerConfig.proactive === true ? { timeZone: String(rule.triggerConfig.timeZone) } : {}),
      body: rule.actions[0]?.type === 'post_message' ? rule.actions[0].body : rule.actions[0]?.type === 'invoke_agent' ? rule.actions[0].prompt ?? '' : '',
      lastRun: lastRun ? { status: lastRun.status, error: lastRun.error, createdAt: lastRun.createdAt,
        ...(typeof lastRun.output.skipped === 'string' ? { skipReason: lastRun.output.skipped } : {}) } : null };
  };
  const ScheduleSchema = z.object({
    requestId: z.string().min(16).max(100), name: z.string().trim().min(2).max(80),
    agentId: z.string().min(1), kind: z.enum(['task', 'reminder', 'followup']), body: z.string().trim().min(1).max(100_000),
    runAt: z.string().datetime({ offset: true }), intervalMinutes: z.number().int().min(1).max(10080).optional(),
    timeZone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Choose a valid time zone').optional(),
  }).strict();
  app.post('/api/v1/conversations/:conversationId/scheduled-tasks', { preHandler: requireAuth }, async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    if (!canRead(conversationId, request.user!.id)) return reply.code(404).send({ error: 'conversation_not_found' });
    const input = ScheduleSchema.parse(request.body);
    if (!isParticipant(app.db, conversationId, input.agentId, 'agent') || blockedAgentIds(app.db, conversationId).includes(input.agentId)) {
      return reply.code(404).send({ error: 'conversation_agent_not_found' });
    }
    const { requestId, ...details } = input;
    const requestKey = JSON.stringify(details);
    const previous = ownTasks(conversationId, request.user!.id).find(rule => rule.triggerConfig.originRequestId === requestId);
    // A lost response may be retried after the task has run. Return the saved
    // result before checking the time, never create or re-enable a second job.
    if (previous) {
      if (previous.triggerConfig.requestKey !== requestKey) return reply.code(409).send({ error: 'schedule_request_changed' });
      return reply.send({ task: taskView(previous) });
    }
    if (Date.parse(input.runAt) <= Date.now()) return reply.code(400).send({ error: 'schedule_time_must_be_in_future' });
    const agent = getAgent(app.db, input.agentId);
    if (input.kind !== 'reminder' && (!agent || !getProviderConfig(app.db, agent.modelPolicy.defaultProviderId))) {
      return reply.code(409).send({ error: 'agent_provider_unavailable' });
    }
    if (input.kind === 'followup') {
      if (!input.timeZone || !input.intervalMinutes || input.intervalMinutes < 1440) return reply.code(400).send({ error: 'followup_daily_interval_required' });
      if (listAutomations(app.db).some(rule => rule.enabled && rule.triggerConfig.proactive === true
        && rule.triggerConfig.conversationId === conversationId && rule.triggerConfig.agentId === input.agentId)) {
        return reply.code(409).send({ error: 'followup_already_enabled' });
      }
    }
    const { automation } = createAutomation(app.db, {
      name: input.name, createdBy: request.user!.id, triggerType: 'schedule',
      triggerConfig: { kind: 'conversation_schedule', conversationId, agentId: input.agentId, runAt: input.runAt,
        ...(input.kind === 'followup' ? { proactive: true, timeZone: input.timeZone } : {}),
        ...(input.intervalMinutes ? { intervalMinutes: input.intervalMinutes } : {}), originRequestId: requestId, requestKey },
      actions: input.kind === 'reminder' ? [{ type: 'post_message', conversationId, body: input.body }]
        : [{ type: 'invoke_agent', agentId: input.agentId, conversationId, prompt: input.body }],
    });
    return reply.code(201).send({ task: taskView(automation) });
  });
  app.get('/api/v1/conversations/:conversationId/scheduled-tasks', { preHandler: requireAuth }, async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    if (!canRead(conversationId, request.user!.id)) return reply.code(404).send({ error: 'conversation_not_found' });
    const tasks = ownTasks(conversationId, request.user!.id).map(taskView);
    return reply.send({ tasks });
  });
  app.delete('/api/v1/conversations/:conversationId/scheduled-tasks/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { conversationId, id } = request.params as { conversationId: string; id: string };
    if (!canRead(conversationId, request.user!.id)) return reply.code(404).send({ error: 'conversation_not_found' });
    const task = ownTasks(conversationId, request.user!.id).find((rule) => rule.id === id);
    if (!task) return reply.code(404).send({ error: 'scheduled_task_not_found' });
    updateAutomation(app.db, id, { ...task, enabled: false });
    return reply.code(204).send();
  });

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
    await dispatchAutomationEvent(deps(), { type: 'webhook', automationId: id, eventId, dedupeKey: eventId ?? JSON.stringify(body), payload: body });
    reply.code(202).send({ accepted: true });
  });

  app.post('/api/v1/automations/events/run', { preHandler: requireAuth }, async (request, reply) => {
    if (!check(request, reply)) return;
    const body = z.object({ eventId: z.string().min(1).max(200).optional(), dedupeKey: z.string().min(1).max(200), payload: z.record(z.string(), z.unknown()).default({}), conversationId: z.string().min(1).optional() }).parse(request.body);
    await dispatchAutomationEvent(deps(), { type: 'run', ...body });
    reply.code(202).send({ accepted: true });
  });
}
