import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { digestSchedule, setDigestSchedule } from './digest.js';
import { NOTIFICATION_TYPES, NotificationPolicyError, type NotificationService } from './service.js';

const ListQuerySchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
const PreferenceBodySchema = z.object({
  type: z.enum(NOTIFICATION_TYPES as [string, ...string[]]),
  channel: z.enum(['in_app', 'email']),
  mode: z.enum(['instant', 'off', 'digest']),
});
const DigestScheduleSchema = z.object({
  frequency: z.enum(['daily', 'weekly']),
  hourUtc: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6).nullable().default(null),
});
const DeliveriesQuerySchema = z.object({
  status: z.enum(['pending', 'delivered', 'failed', 'skipped']).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

/** A person's own notifications and preferences; admins also see how deliveries went. */
export function registerNotificationRoutes(app: FastifyInstance, service: NotificationService): void {
  app.get('/api/v1/notifications', { preHandler: requireAuth }, async (request, reply) => {
    const query = ListQuerySchema.parse(request.query);
    const userId = request.user!.id;
    reply.send({
      notifications: service.listForUser(userId, { unreadOnly: query.unread === 'true', limit: query.limit }),
      unread: service.unreadCount(userId),
    });
  });

  app.post('/api/v1/notifications/read-all', { preHandler: requireAuth }, async (request, reply) => {
    reply.send({ marked: service.markRead(request.user!.id) });
  });

  app.post('/api/v1/notifications/:id/read', { preHandler: requireAuth }, async (request, reply) => {
    service.markRead(request.user!.id, (request.params as { id: string }).id);
    reply.code(204).send();
  });

  app.get('/api/v1/notifications/preferences', { preHandler: requireAuth }, async (request, reply) => {
    reply.send({ preferences: service.preferences(request.user!.id) });
  });

  app.put('/api/v1/notifications/preferences', { preHandler: requireAuth }, async (request, reply) => {
    const body = PreferenceBodySchema.parse(request.body);
    try {
      service.setPreference(request.user!.id, body.type as never, body.channel, body.mode);
    } catch (error) {
      if (error instanceof NotificationPolicyError) {
        reply.code(400).send({ error: 'preference_not_allowed', message: error.message });
        return;
      }
      throw error;
    }
    reply.send({ preferences: service.preferences(request.user!.id) });
  });

  /** When the person's digest email goes out, for events they set to `digest`. */
  app.get('/api/v1/notifications/digest', { preHandler: requireAuth }, async (request, reply) => {
    reply.send({ schedule: digestSchedule(app.db, request.user!.id) });
  });

  app.put('/api/v1/notifications/digest', { preHandler: requireAuth }, async (request, reply) => {
    reply.send({ schedule: setDigestSchedule(app.db, request.user!.id, DigestScheduleSchema.parse(request.body)) });
  });

  app.get('/api/v1/server/notifications/deliveries', { preHandler: requireAuth }, async (request, reply) => {
    const role = request.user!.role;
    if (role !== 'owner' && role !== 'admin') {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    reply.send({ deliveries: service.listDeliveries(DeliveriesQuerySchema.parse(request.query)) });
  });
}
