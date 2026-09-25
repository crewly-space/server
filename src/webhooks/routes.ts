import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { isChannelAdmin, getChannel, type Reader } from '../channels/repository.js';
import { deliverWebhook, createWebhook, listWebhooks, revokeWebhook, rotateWebhook, WEBHOOK_MAX_BODY_BYTES } from './service.js';

const CreateSchema = z.object({ name: z.string().trim().min(1).max(80) });
const PayloadSchema = z.record(z.string().max(100), z.unknown());

function admin(request: FastifyRequest, reply: FastifyReply): boolean { if (isChannelAdmin(request.user!.role as 'member' | 'admin' | 'owner')) return true; reply.code(403).send({ error: 'forbidden' }); return false; }
function channelFor(app: FastifyInstance, request: FastifyRequest) { const { channelId } = request.params as { channelId: string }; return getChannel(app.db, channelId, { id: request.user!.id, role: request.user!.role as Reader['role'] }); }

export function registerWebhookRoutes(app: FastifyInstance, options: { publicUrl?: string } = {}): void {
  const endpointBase = options.publicUrl ?? '';
  app.get('/api/v1/channels/:channelId/webhooks', { preHandler: requireAuth }, async (request, reply) => { if (!admin(request, reply)) return; if (!channelFor(app, request)) { reply.code(404).send({ error: 'channel_not_found' }); return; } reply.send({ webhooks: listWebhooks(app.db, (request.params as { channelId: string }).channelId) }); });
  app.post('/api/v1/channels/:channelId/webhooks', { preHandler: requireAuth }, async (request, reply) => { if (!admin(request, reply)) return; if (!channelFor(app, request)) { reply.code(404).send({ error: 'channel_not_found' }); return; } const { channelId } = request.params as { channelId: string }; const created = createWebhook(app.db, { channelId, name: CreateSchema.parse(request.body).name, createdBy: request.user!.id, endpointBase }); reply.code(201).send(created); });
  app.post('/api/v1/webhooks/:id/rotate', { preHandler: requireAuth }, async (request, reply) => { if (!admin(request, reply)) return; const created = rotateWebhook(app.db, (request.params as { id: string }).id, endpointBase); if (!created) { reply.code(404).send({ error: 'webhook_not_found' }); return; } reply.send(created); });
  app.post('/api/v1/webhooks/:id/revoke', { preHandler: requireAuth }, async (request, reply) => { if (!admin(request, reply)) return; const revoked = revokeWebhook(app.db, (request.params as { id: string }).id); if (!revoked) { reply.code(404).send({ error: 'webhook_not_found' }); return; } reply.send(revoked); });
  app.post('/api/v1/webhooks/:id/:secret', async (request, reply) => {
    const raw = JSON.stringify(request.body ?? {}); if (Buffer.byteLength(raw, 'utf8') > WEBHOOK_MAX_BODY_BYTES) { reply.code(413).send({ error: 'payload_too_large' }); return; }
    try {
      const payload = PayloadSchema.parse(request.body);
      const result = deliverWebhook(app.db, { id: (request.params as { id: string }).id, secret: (request.params as { secret: string }).secret, payload, externalEventId: typeof request.headers['x-webhook-event-id'] === 'string' ? request.headers['x-webhook-event-id'] : typeof payload.event_id === 'string' ? payload.event_id : undefined });
      app.hub.publish(`conversation:${result.message.conversationId}`, 'message.created', { ...result.message });
      reply.code(result.duplicate ? 200 : 201).send({ accepted: true, duplicate: result.duplicate, messageId: result.message.id });
    } catch (error) { if (error instanceof Error && error.message === 'webhook_rate_limited') { reply.code(429).send({ error: error.message }); return; } reply.code(404).send({ error: 'webhook_not_found' }); }
  });
}
