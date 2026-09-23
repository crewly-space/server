import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { crewlyServiceCredential } from '../crewly/connection.js';
import { MAIL_PROVIDERS } from './providers.js';
import { MAIL_MAX_ATTEMPTS, MAIL_RETRY_DELAYS_MS, MailDisabledError, MailSettingsError, type MailService } from './service.js';

const SettingsBodySchema = z.object({
  provider: z.enum(MAIL_PROVIDERS),
  fromAddress: z.string().trim().min(3).max(320).regex(/^[^\r\n]+$/).nullable().optional(),
  config: z.object({
    host: z.string().trim().min(1).max(253).optional(),
    port: z.coerce.number().int().min(1).max(65_535).optional(),
    security: z.enum(['tls', 'starttls', 'none']).optional(),
    username: z.string().max(320).optional(),
  }).strict().optional(),
  secret: z.string().min(1).max(4096).optional(),
});
const TestBodySchema = z.object({ to: z.string().email().max(320) });
const DeliveriesQuerySchema = z.object({
  status: z.enum(['queued', 'sent', 'retrying', 'failed']).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

function isAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const role = request.user!.role;
  if (role === 'owner' || role === 'admin') return true;
  reply.code(403).send({ error: 'forbidden' });
  return false;
}

/**
 * Mail settings, test-send and the delivery log. Owners and admins only; the
 * password or API key goes in and never comes back out.
 */
export function registerMailRoutes(app: FastifyInstance, mail: MailService, options: { fetchImpl: typeof fetch }): void {
  app.get('/api/v1/server/mail', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    reply.send({
      settings: mail.settings(),
      providers: MAIL_PROVIDERS,
      // Whether Crewly Mail would work right now, so the choice can say why not.
      crewlyMailAvailable: crewlyServiceCredential(app.db, 'mail:send') !== undefined,
      retryPolicy: { maxAttempts: MAIL_MAX_ATTEMPTS, delaysMs: MAIL_RETRY_DELAYS_MS },
    });
  });

  app.put('/api/v1/server/mail', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    try {
      reply.send({ settings: mail.updateSettings(SettingsBodySchema.parse(request.body), request.user!.id) });
    } catch (error) {
      if (error instanceof MailSettingsError) {
        reply.code(400).send({ error: 'invalid_mail_settings', message: error.message });
        return;
      }
      throw error;
    }
  });

  app.post('/api/v1/server/mail/test', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    const { to } = TestBodySchema.parse(request.body);
    try {
      reply.send({ delivery: await mail.send({ to, template: { id: 'mail.test', variables: {} } }) });
    } catch (error) {
      if (error instanceof MailDisabledError || error instanceof MailSettingsError) {
        reply.code(409).send({ error: 'mail_unavailable', message: error.message });
        return;
      }
      throw error;
    }
  });

  app.get('/api/v1/server/mail/deliveries', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    reply.send({ deliveries: mail.listDeliveries(DeliveriesQuerySchema.parse(request.query)) });
  });

  app.post('/api/v1/server/mail/deliveries/:id/retry', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    const delivery = await mail.retry((request.params as { id: string }).id);
    if (!delivery) {
      reply.code(404).send({ error: 'delivery_not_found' });
      return;
    }
    reply.send({ delivery });
  });

  /** What Crewly Mail has counted against this server, as Crewly reports it. */
  app.get('/api/v1/server/mail/usage', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    const connection = crewlyServiceCredential(app.db, 'mail:send');
    if (!connection) {
      reply.send({ available: false });
      return;
    }
    try {
      const response = await options.fetchImpl(new URL('/api/v1/instance/mail/usage', connection.cloudUrl), {
        headers: { authorization: `Bearer ${connection.credential}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        reply.send({ available: false });
        return;
      }
      reply.send({ available: true, ...((await response.json()) as Record<string, unknown>) });
    } catch {
      reply.send({ available: false });
    }
  });
}
