import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { consumeNonce, HandoffRejected, verifyManagedConnectionToken, type CloudHandoffConfig } from '../auth/cloud-handoff.js';
import {
  adoptManagedConnection,
  CrewlyConnectionError,
  disconnectCrewly,
  getCrewlyConnection,
  listCrewlyAudit,
  pollCrewlyLink,
  refreshCrewlyConnection,
  rotateCrewlyCredential,
  SCOPE,
  startCrewlyLink,
  type CrewlyActor,
} from './connection.js';

const ConnectBodySchema = z.object({
  name: z.string().trim().min(1).max(80).default('Crewly server'),
  scopes: z.array(z.string().regex(SCOPE)).max(20).default([]),
});
const AuditQuerySchema = z.object({ limit: z.coerce.number().int().positive().max(500).default(100) });

function asAdmin(request: FastifyRequest, reply: FastifyReply): CrewlyActor | undefined {
  const role = request.user!.role;
  if (role === 'owner' || role === 'admin') return { type: 'user', id: request.user!.id };
  reply.code(403).send({ error: 'forbidden' });
  return undefined;
}

async function guarded(reply: FastifyReply, action: () => Promise<unknown>): Promise<void> {
  try {
    reply.send(await action());
  } catch (error) {
    if (error instanceof CrewlyConnectionError) {
      reply.code(error.statusCode).send({ error: 'crewly_connection', message: error.message });
      return;
    }
    throw error;
  }
}

/**
 * Connect Crewly: the owner or an admin links this server to a Crewly account
 * from settings, without editing configuration. Nothing here returns a
 * credential; it stays on the server.
 */
export function registerCrewlyRoutes(
  app: FastifyInstance,
  options: { cloudUrl: string; fetchImpl: typeof fetch; version: string; cloudHandoff?: CloudHandoffConfig },
): void {
  const { cloudUrl, fetchImpl } = options;

  /*
   * Cloud handing a server it hosts that server's own instance credential, so
   * Crewly Mail, connector sign-in and the rest work without anybody linking
   * it by hand. Only a hosted server has this door: the token is signed with
   * the key it already trusts for sign-ins, and names this deployment.
   */
  if (options.cloudHandoff) {
    const handoff = options.cloudHandoff;
    app.post('/api/v1/crewly/managed-connection', async (request, reply) => {
      const body = z.object({ token: z.string().min(1).max(8192) }).parse(request.body);
      let claims;
      try {
        claims = verifyManagedConnectionToken(body.token, handoff);
      } catch (error) {
        if (error instanceof HandoffRejected) {
          request.log.warn({ reason: error.message }, 'managed Crewly connection refused');
          reply.code(401).send({ error: 'invalid_token' });
          return;
        }
        throw error;
      }
      if (!consumeNonce(app.db, claims.nonce, new Date(claims.exp * 1000))) {
        reply.code(401).send({ error: 'invalid_token' });
        return;
      }
      const connection = adoptManagedConnection(app.db, claims);
      reply.code(200).send({ status: connection.status, instanceId: connection.instanceId, scopes: connection.scopes });
    });
  }

  app.get('/api/v1/server/crewly', { preHandler: requireAuth }, async (request, reply) => {
    if (!asAdmin(request, reply)) return;
    reply.send(getCrewlyConnection(app.db));
  });

  app.post('/api/v1/server/crewly/connect', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    const body = ConnectBodySchema.parse(request.body ?? {});
    await guarded(reply, () => startCrewlyLink(app.db, fetchImpl, {
      cloudUrl,
      name: body.name,
      // What the admin reached this server at is the best address there is to show the owner.
      baseUrl: request.headers.host ? `${request.protocol}://${request.headers.host}` : undefined,
      version: options.version,
      scopes: [...new Set(body.scopes)].sort(),
    }, actor));
  });

  app.post('/api/v1/server/crewly/connect/poll', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    await guarded(reply, () => pollCrewlyLink(app.db, fetchImpl, actor));
  });

  app.post('/api/v1/server/crewly/refresh', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    await guarded(reply, () => refreshCrewlyConnection(app.db, fetchImpl, actor));
  });

  app.post('/api/v1/server/crewly/credential/rotate', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    await guarded(reply, () => rotateCrewlyCredential(app.db, fetchImpl, actor));
  });

  app.delete('/api/v1/server/crewly', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    await guarded(reply, () => disconnectCrewly(app.db, fetchImpl, actor));
  });

  app.get('/api/v1/server/crewly/audit', { preHandler: requireAuth }, async (request, reply) => {
    if (!asAdmin(request, reply)) return;
    reply.send({ entries: listCrewlyAudit(app.db, AuditQuerySchema.parse(request.query).limit) });
  });
}
