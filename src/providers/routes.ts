import { AGENTD_BACKED_PROVIDER_KINDS, ProviderKindSchema, type ProviderKind } from '../protocol/index.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { hasPermission } from '../permissions/roles.js';
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
import { providerHealth } from '../gateway/health.js';
import { enableOnDevices } from './device-enable.js';
import { describeModelListFailure } from './errors.js';

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
    if (isAgentdBackedKind(body.kind) || body.kind === 'crewly-gateway') return;

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

function availability(config: ProviderConfigRecord, health: { status: string; reason?: string }) {
  return {
    id: config.id,
    kind: config.kind,
    hasApiKey: config.apiKey !== null,
    status: health.status,
    ...(health.reason ? { statusReason: health.reason } : {}),
  };
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
    if (!hasPermission(app.db, request.user!.id, 'providers.manage')) {
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
    if (!hasPermission(app.db, request.user!.id, 'providers.manage')) {
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
      app.agentStatus.refresh();
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
    if (!hasPermission(app.db, request.user!.id, 'providers.manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const body = CreateProviderBodySchema.parse(request.body);
    if (getProviderConfig(app.db, body.id)) {
      reply.code(409).send({ error: 'provider_exists' });
      return;
    }
    const config = createProviderConfig(app.db, body);
    // A device-backed provider also has to be switched on where it runs. The
    // requester's own signed-in devices are asked to do that now, so nobody
    // has to open a terminal; each outcome is returned so the app can say
    // which device took it, or why none could.
    const devices = (AGENTD_BACKED_PROVIDER_KINDS as readonly string[]).includes(config.kind)
      ? await enableOnDevices(app.db, app.deviceHub, request.user!.id, config.kind)
      : undefined;
    app.agentStatus.refresh();
    reply.code(201).send({ ...redact(config), ...(devices ? { devices } : {}) });
  });

  /*
   * Asks again. A device that was signed out, asleep or missing Claude Code
   * when the provider was connected can be fixed later; this is how the app
   * tries once more without deleting and recreating the provider.
   */
  app.post('/api/v1/providers/:id/enable-on-devices', { preHandler: requireAuth }, async (request, reply) => {
    if (!hasPermission(app.db, request.user!.id, 'providers.manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { id } = request.params as { id: string };
    const config = getProviderConfig(app.db, id);
    if (!config) {
      reply.code(404).send({ error: 'provider_not_found' });
      return;
    }
    if (!(AGENTD_BACKED_PROVIDER_KINDS as readonly string[]).includes(config.kind)) {
      reply.code(400).send({ error: 'not_device_backed' });
      return;
    }
    const devices = await enableOnDevices(app.db, app.deviceHub, request.user!.id, config.kind);
    app.agentStatus.refresh();
    reply.send({ devices });
  });

  app.get('/api/v1/providers', { preHandler: requireAuth }, async (request, reply) => {
    if (!hasPermission(app.db, request.user!.id, 'providers.manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    reply.send(listProviderConfigs(app.db).map(redact));
  });

  // Members need provider IDs and kinds to configure their own agents, but do
  // not receive provider URLs, timestamps, or any credential-management data.
  app.get('/api/v1/providers/available', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send(listProviderConfigs(app.db).map((config) => availability(config, healthOf(config))));
  });

  const healthOf = (config: ProviderConfigRecord) =>
    providerHealth(app.db, config, { rateLimits: app.gateway.rateLimits, deviceHub: app.deviceHub });

  /**
   * How each provider has actually been doing: calls, errors, latency and the
   * rate limit it last reported, over the last hour of real traffic.
   */
  app.get('/api/v1/providers/health', { preHandler: requireAuth }, async (request, reply) => {
    if (!hasPermission(app.db, request.user!.id, 'providers.manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    reply.send({ providers: listProviderConfigs(app.db).map(healthOf) });
  });

  app.patch('/api/v1/providers/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!hasPermission(app.db, request.user!.id, 'providers.manage')) {
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
    app.agentStatus.refresh();
    reply.send(redact(config));
  });

  app.delete('/api/v1/providers/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!hasPermission(app.db, request.user!.id, 'providers.manage')) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { id } = request.params as { id: string };
    if (!deleteProviderConfig(app.db, id)) {
      reply.code(404).send({ error: 'provider_not_found' });
      return;
    }
    app.agentStatus.refresh();
    reply.code(204).send();
  });

  // Resolved per call rather than captured, so a fetch swapped in after the
  // app is built (tests do this) is the one used.
  const modelFetch: typeof fetch = (input, init) => (options.fetchImpl ?? globalThis.fetch)(input, init);

  app.get('/api/v1/providers/:id/models', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = getProviderConfig(app.db, id);
    if (!config) {
      reply.code(404).send({ error: 'provider_not_found' });
      return;
    }
    const started = Date.now();
    try {
      const client = resolveProviderClient(config, modelFetch, {
        db: app.db, hub: app.deviceHub, ownerUserId: request.user!.id,
      });
      const models = await client.listModels(config.id);
      reply.send([...models].sort((a, b) => a.displayName.localeCompare(b.displayName)));
    } catch (err) {
      const failure = describeModelListFailure(err);
      request.log.warn({
        providerId: config.id,
        providerKind: config.kind,
        code: failure.code,
        durationMs: Date.now() - started,
        detail: (err as Error)?.message,
      }, 'provider model discovery failed');
      reply.code(502).send({ error: failure.code, message: failure.message, retryable: failure.retryable });
    }
  });
}
