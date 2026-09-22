import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  createSecret,
  deleteSecret,
  getSecret,
  GRANTEE_TYPES,
  listSecretAudit,
  listSecrets,
  revokeSecret,
  rotateSecret,
  SECRET_NAME,
  secretDependents,
  SecretInUseError,
  SecretNameTakenError,
  SecretNotFoundError,
  setSecretGrants,
  updateSecret,
  type SecretActor,
} from './vault.js';

const NameSchema = z.string().regex(SECRET_NAME, 'Use UPPER_SNAKE_CASE, up to 64 characters');
// Big enough for a PEM key or a service-account JSON; small enough to stay a credential.
const ValueSchema = z.string().min(1).max(64 * 1024);

const CreateBodySchema = z.object({ name: NameSchema, value: ValueSchema, description: z.string().max(500).optional() });
const UpdateBodySchema = z.object({ name: NameSchema.optional(), description: z.string().max(500).optional() });
const RotateBodySchema = z.object({ value: ValueSchema });
const GrantsBodySchema = z.object({
  grants: z.array(z.object({ type: z.enum(GRANTEE_TYPES as [string, ...string[]]), id: z.string().min(1).max(200) })).max(200),
});
const ForceQuerySchema = z.object({ force: z.enum(['true', 'false']).optional() });
const AuditQuerySchema = z.object({
  secretId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

function asAdmin(request: FastifyRequest, reply: FastifyReply): SecretActor | undefined {
  const role = request.user!.role;
  if (role === 'owner' || role === 'admin') return { type: 'user', id: request.user!.id };
  reply.code(403).send({ error: 'forbidden' });
  return undefined;
}

function sendVaultError(reply: FastifyReply, error: unknown): void {
  if (error instanceof SecretNotFoundError) {
    reply.code(404).send({ error: 'secret_not_found' });
    return;
  }
  if (error instanceof SecretNameTakenError) {
    reply.code(409).send({ error: 'secret_name_taken', message: 'A secret with that name already exists' });
    return;
  }
  if (error instanceof SecretInUseError) {
    // Say what would break, so it can be fixed first or knowingly forced.
    reply.code(409).send({ error: 'secret_in_use', message: error.message, dependents: error.dependents });
    return;
  }
  throw error;
}

/**
 * The server's secrets vault. Owners and admins manage it; values go in and
 * never come back out over the API -- only the things they were granted to
 * can read them, and each read is audited.
 */
export function registerSecretRoutes(app: FastifyInstance): void {
  app.get('/api/v1/secrets', { preHandler: requireAuth }, async (request, reply) => {
    if (!asAdmin(request, reply)) return;
    reply.send({ secrets: listSecrets(app.db) });
  });

  app.post('/api/v1/secrets', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    const body = CreateBodySchema.parse(request.body);
    try {
      reply.code(201).send(createSecret(app.db, body, actor));
    } catch (error) {
      sendVaultError(reply, error);
    }
  });

  app.patch('/api/v1/secrets/:id', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const { force } = ForceQuerySchema.parse(request.query);
    try {
      reply.send(updateSecret(app.db, id, UpdateBodySchema.parse(request.body), actor, { force: force === 'true' }));
    } catch (error) {
      sendVaultError(reply, error);
    }
  });

  app.put('/api/v1/secrets/:id/value', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    try {
      reply.send(rotateSecret(app.db, id, RotateBodySchema.parse(request.body).value, actor));
    } catch (error) {
      sendVaultError(reply, error);
    }
  });

  app.post('/api/v1/secrets/:id/revoke', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    try {
      reply.send(revokeSecret(app.db, id, actor));
    } catch (error) {
      sendVaultError(reply, error);
    }
  });

  app.put('/api/v1/secrets/:id/grants', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const { grants } = GrantsBodySchema.parse(request.body);
    try {
      reply.send(setSecretGrants(app.db, id, grants as Parameters<typeof setSecretGrants>[2], actor));
    } catch (error) {
      sendVaultError(reply, error);
    }
  });

  app.get('/api/v1/secrets/:id/dependents', { preHandler: requireAuth }, async (request, reply) => {
    if (!asAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    try {
      reply.send({ dependents: secretDependents(app.db, id) });
    } catch (error) {
      sendVaultError(reply, error);
    }
  });

  app.delete('/api/v1/secrets/:id', { preHandler: requireAuth }, async (request, reply) => {
    const actor = asAdmin(request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const { force } = ForceQuerySchema.parse(request.query);
    try {
      if (!getSecret(app.db, id)) throw new SecretNotFoundError(id);
      deleteSecret(app.db, id, actor, { force: force === 'true' });
      reply.code(204).send();
    } catch (error) {
      sendVaultError(reply, error);
    }
  });

  app.get('/api/v1/secrets/audit', { preHandler: requireAuth }, async (request, reply) => {
    if (!asAdmin(request, reply)) return;
    reply.send({ entries: listSecretAudit(app.db, AuditQuerySchema.parse(request.query)) });
  });
}
