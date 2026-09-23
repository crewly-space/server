import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { CrewlyConnectionError, crewlyServiceCredential, crewlyServiceRequest } from '../crewly/connection.js';
import { getConversation, isParticipant } from '../conversations/repository.js';
import { listInboundMail } from './inbound.js';
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
const DomainBodySchema = z.object({ domain: z.string().trim().min(4).max(253) });
const SendersBodySchema = z.object({
  senders: z.array(z.object({ localPart: z.string().min(1).max(64), name: z.string().max(80).nullable().optional() })).min(1).max(20),
});
const InboundRouteBodySchema = z.object({ address: z.string().trim().toLowerCase().email().max(320), conversationId: z.string().min(1) });
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

  /*
   * Custom sending domains for Crewly Mail. They live in Crewly, which owns
   * verification; these routes carry the admin's request there with this
   * server's instance credential, which never leaves the server.
   */
  const toCrewly = async (reply: FastifyReply, method: string, path: string, body?: unknown, scope = 'mail:send'): Promise<void> => {
    try {
      const answer = await crewlyServiceRequest(app.db, options.fetchImpl, scope, method, path, body);
      if (answer.status === 204) {
        reply.code(204).send();
        return;
      }
      // Crewly's own words for a refusal are written for the person reading them.
      reply.code(answer.status).send(answer.status < 400 ? answer.body : { error: 'crewly_refused', message: String(answer.body.error ?? 'Crewly refused') });
    } catch (error) {
      if (!(error instanceof CrewlyConnectionError)) throw error;
      reply.code(error.statusCode).send({ error: 'crewly_unavailable', message: error.message });
    }
  };
  const domainPath = (id: string) => `/api/v1/instance/mail/domains/${encodeURIComponent(id)}`;

  app.get('/api/v1/server/mail/domains', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    await toCrewly(reply, 'GET', '/api/v1/instance/mail/domains');
  });

  app.post('/api/v1/server/mail/domains', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    await toCrewly(reply, 'POST', '/api/v1/instance/mail/domains', DomainBodySchema.parse(request.body));
  });

  app.post('/api/v1/server/mail/domains/:id/check', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    await toCrewly(reply, 'POST', `${domainPath((request.params as { id: string }).id)}/check`);
  });

  app.put('/api/v1/server/mail/domains/:id/senders', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    await toCrewly(reply, 'PUT', `${domainPath((request.params as { id: string }).id)}/senders`, SendersBodySchema.parse(request.body));
  });

  app.delete('/api/v1/server/mail/domains/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    await toCrewly(reply, 'DELETE', domainPath((request.params as { id: string }).id));
  });

  /*
   * Inbound mail (`mail:receive`): what came in and what became of it, what
   * Crewly refused for this server, and addresses that post into a channel.
   */
  app.get('/api/v1/server/mail/inbound', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    reply.send({ messages: listInboundMail(app.db, DeliveriesQuerySchema.parse(request.query).limit) });
  });

  app.get('/api/v1/server/mail/inbound/rejections', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    await toCrewly(reply, 'GET', '/api/v1/instance/mail/inbound/rejections', undefined, 'mail:receive');
  });

  app.get('/api/v1/server/mail/inbound/routes', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    reply.send({
      routes: app.db.prepare(
        'SELECT address, conversation_id AS conversationId, posted_by AS postedBy, created_at AS createdAt FROM mail_inbound_routes ORDER BY address',
      ).all(),
    });
  });

  /** The address must be on a verified sending domain; Crewly checks, and holds it for this server alone. */
  app.post('/api/v1/server/mail/inbound/routes', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    const { address, conversationId } = InboundRouteBodySchema.parse(request.body);
    // Posted as the admin setting it up, so it has to be somewhere they can post.
    if (!getConversation(app.db, conversationId) || !isParticipant(app.db, conversationId, request.user!.id, 'user')) {
      reply.code(400).send({ error: 'invalid_conversation', message: 'Choose a conversation you are a member of' });
      return;
    }
    if (app.db.prepare('SELECT 1 FROM mail_inbound_routes WHERE address = ?').get(address)) {
      reply.code(409).send({ error: 'route_exists', message: 'That address already routes somewhere' });
      return;
    }
    try {
      const answer = await crewlyServiceRequest(app.db, options.fetchImpl, 'mail:receive', 'POST', '/api/v1/instance/mail/inbound/routes', { address, target: conversationId });
      if (answer.status !== 201) {
        reply.code(answer.status).send({ error: 'crewly_refused', message: String(answer.body.error ?? 'Crewly refused') });
        return;
      }
    } catch (error) {
      if (!(error instanceof CrewlyConnectionError)) throw error;
      reply.code(error.statusCode).send({ error: 'crewly_unavailable', message: error.message });
      return;
    }
    const route = { address, conversationId, postedBy: request.user!.id, createdAt: new Date().toISOString() };
    app.db.prepare('INSERT INTO mail_inbound_routes (address, conversation_id, posted_by, created_at) VALUES (?, ?, ?, ?)')
      .run(route.address, route.conversationId, route.postedBy, route.createdAt);
    reply.code(201).send({ route });
  });

  app.delete('/api/v1/server/mail/inbound/routes/:address', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    const address = decodeURIComponent((request.params as { address: string }).address).toLowerCase();
    // Stop posting here first; Crewly letting go of the address is best effort.
    const removed = app.db.prepare('DELETE FROM mail_inbound_routes WHERE address = ?').run(address).changes;
    await crewlyServiceRequest(app.db, options.fetchImpl, 'mail:receive', 'DELETE', `/api/v1/instance/mail/inbound/routes/${encodeURIComponent(address)}`).catch(() => undefined);
    reply.code(removed ? 204 : 404).send(removed ? undefined : { error: 'route_not_found' });
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
