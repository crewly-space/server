import { AGENTD_BACKED_PROVIDER_KINDS, ProviderKindSchema, type ProviderKind } from '../protocol/index.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { can, type Role } from '../permissions/model.js';
import {
  createProviderConfig,
  deleteProviderConfig,
  getProviderConfig,
  listProviderConfigs,
  updateProviderConfig,
  type ProviderConfigRecord,
} from './repository.js';
import {
  consumeProviderState,
  exchangeProviderCode,
  OAUTH_CAPABLE_PROVIDER_KINDS,
  ProviderOAuthError,
  startProviderAuthorization,
  type OAuthProviderKind,
} from './oauth.js';
import { resolveProviderClient } from './registry.js';

function isAgentdBackedKind(kind: ProviderKind): boolean {
  return (AGENTD_BACKED_PROVIDER_KINDS as readonly ProviderKind[]).includes(kind);
}

const CreateProviderBodySchema = z
  .object({
    id: z.string().min(1),
    kind: ProviderKindSchema,
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().min(1).optional(),
  })
  .superRefine((body, ctx) => {
    // agentd-backed kinds (claude-subscription, ollama) don't consume apiKey/baseUrl
    // the same way remote providers do, so they stay optional for those kinds.
    if (isAgentdBackedKind(body.kind)) return;

    if (!body.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: `apiKey is required for provider kind "${body.kind}"`,
      });
    }
    if (body.kind === 'openai-compatible' && !body.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: 'baseUrl is required for provider kind "openai-compatible"',
      });
    }
  });

const UpdateProviderBodySchema = z.object({
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
}).refine((body) => body.apiKey !== undefined || body.baseUrl !== undefined, {
  message: 'provide apiKey or baseUrl',
});

function redact(config: ProviderConfigRecord) {
  const { apiKey, ...rest } = config;
  return { ...rest, hasApiKey: apiKey !== null };
}

function availability(config: ProviderConfigRecord) {
  return { id: config.id, kind: config.kind, hasApiKey: config.apiKey !== null };
}

const OAuthStartBodySchema = z.object({
  kind: z.enum(['openrouter']),
  id: z.string().min(1).max(64).optional(),
  callbackUrl: z.string().url(),
});

const OAuthCompleteBodySchema = z.object({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(2048),
});

export function registerProviderRoutes(
  app: FastifyInstance,
  options: { fetchImpl?: typeof fetch } = {}
): void {
  const oauthFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  /** Which provider kinds can be connected by signing in rather than by key. */
  app.get('/api/v1/providers/oauth/kinds', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send({ kinds: OAUTH_CAPABLE_PROVIDER_KINDS });
  });

  app.post('/api/v1/providers/oauth/start', { preHandler: requireAuth }, async (request, reply) => {
    if (!can(request.user!.role as Role, 'provider:manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const body = OAuthStartBodySchema.parse(request.body);
    const providerId = body.id ?? body.kind;
    if (getProviderConfig(app.db, providerId)) {
      reply.code(409).send({ error: 'provider_exists' });
      return;
    }
    const pending = startProviderAuthorization(app.db, {
      kind: body.kind as OAuthProviderKind,
      providerId,
      userId: request.user!.id,
      callbackUrl: body.callbackUrl,
    });
    reply.send(pending);
  });

  app.post('/api/v1/providers/oauth/complete', { preHandler: requireAuth }, async (request, reply) => {
    if (!can(request.user!.role as Role, 'provider:manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const body = OAuthCompleteBodySchema.parse(request.body);
    try {
      const pending = consumeProviderState(app.db, { state: body.state, userId: request.user!.id });
      const apiKey = await exchangeProviderCode(
        { kind: pending.kind, code: body.code, codeVerifier: pending.codeVerifier },
        oauthFetch
      );
      if (getProviderConfig(app.db, pending.providerId)) {
        reply.code(409).send({ error: 'provider_exists' });
        return;
      }
      const config = createProviderConfig(app.db, {
        id: pending.providerId,
        kind: pending.kind,
        apiKey,
      });
      reply.code(201).send(redact(config));
    } catch (err) {
      if (err instanceof ProviderOAuthError) {
        reply.code(err.statusCode).send({ error: 'provider_oauth_failed', message: err.message });
        return;
      }
      throw err;
    }
  });

  app.post('/api/v1/providers', { preHandler: requireAuth }, async (request, reply) => {
    if (!can(request.user!.role as Role, 'provider:manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const body = CreateProviderBodySchema.parse(request.body);
    if (getProviderConfig(app.db, body.id)) {
      reply.code(409).send({ error: 'provider_exists' });
      return;
    }
    const config = createProviderConfig(app.db, body);
    reply.code(201).send(redact(config));
  });

  app.get('/api/v1/providers', { preHandler: requireAuth }, async (request, reply) => {
    if (!can(request.user!.role as Role, 'provider:manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    reply.send(listProviderConfigs(app.db).map(redact));
  });

  // Members need provider IDs and kinds to configure their own agents, but do
  // not receive provider URLs, timestamps, or any credential-management data.
  app.get('/api/v1/providers/available', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send(listProviderConfigs(app.db).map(availability));
  });

  app.patch('/api/v1/providers/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!can(request.user!.role as Role, 'provider:manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { id } = request.params as { id: string };
    const body = UpdateProviderBodySchema.parse(request.body);
    const config = updateProviderConfig(app.db, id, body);
    if (!config) {
      reply.code(404).send({ error: 'provider_not_found' });
      return;
    }
    reply.send(redact(config));
  });

  app.delete('/api/v1/providers/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!can(request.user!.role as Role, 'provider:manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { id } = request.params as { id: string };
    if (!deleteProviderConfig(app.db, id)) {
      reply.code(404).send({ error: 'provider_not_found' });
      return;
    }
    reply.code(204).send();
  });

  app.get('/api/v1/providers/:id/models', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = getProviderConfig(app.db, id);
    if (!config) {
      reply.code(404).send({ error: 'provider_not_found' });
      return;
    }
    try {
      const client = resolveProviderClient(config, globalThis.fetch.bind(globalThis), {
        db: app.db, hub: app.deviceHub, ownerUserId: request.user!.id,
      });
      reply.send(await client.listModels());
    } catch (err) {
      reply.code(502).send({ error: 'provider_unavailable', message: (err as Error).message });
    }
  });
}
