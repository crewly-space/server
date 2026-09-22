import websocketPlugin from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from './db/driver.js';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { registerAgentRoutes } from './agents/routes.js';
import { registerServerAdminRoutes } from './admin/routes.js';
import { registerApprovalRoutes } from './approvals/routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { CloudHandoffConfig } from './auth/cloud-handoff.js';
import { registerConversationRoutes } from './conversations/routes.js';
import { registerMessageRoutes } from './messages/routes.js';
import { registerConversationSummaryRoutes, registerMemoryFactRoutes } from './memory/routes.js';
import { registerProviderRoutes } from './providers/routes.js';
import { type RespondFn } from './runtime/engine.js';
import { createProviderRespond } from './providers/respond.js';
import { AiGateway } from './gateway/gateway.js';
import { installBudgets } from './usage/budgets.js';
import { AgentStatusBroadcaster } from './agents/status.js';
import { AgentRunQueue } from './runtime/queue.js';
import { delegationToolset } from './runtime/delegation.js';
import { priceCall } from './usage/pricing.js';
import { registerUsageRoutes } from './usage/routes.js';
import { registerSecretRoutes } from './secrets/routes.js';
import { registerMcpRoutes } from './mcp/routes.js';
import { mcpToolset, registerMcpSecretHooks } from './mcp/service.js';
import { registerSkillRoutes } from './skills/routes.js';
import { registerSkillSecretHooks, skillInstructions } from './skills/skills.js';
import { registerRuntimeRoutes } from './runtime/routes.js';
import { registerRunInspectorRoutes } from './runtime/inspector-routes.js';
import { ConnectionHub } from './ws/hub.js';
import { registerWsRoutes } from './ws/routes.js';
import { registerUserRoutes } from './users/routes.js';
import { DeviceConnectionHub } from './devices/hub.js';
import { registerDeviceRoutes } from './devices/routes.js';
import { registerDeviceSocket } from './devices/socket.js';

export interface BuildAppOptions {
  db: Database;
  respond?: RespondFn;
  webDir?: string;
  logger?: boolean | { level: string };
  trustProxy?: boolean;
  /** Outbound fetch for provider OAuth exchanges; injected by tests. */
  fetchImpl?: typeof fetch;
  /** One-time secret required by the first owner setup on a packaged server. */
  setupClaimToken?: string;
  onSetupComplete?: () => void;
  /** Set when this server was provisioned by a Crewly Cloud that can sign people in. */
  cloudHandoff?: CloudHandoffConfig;
  /**
   * Origins allowed to call this server's API from a browser, such as the
   * hosted app. Empty by default: a self-hosted server serves its own app from
   * its own origin and needs no cross-origin caller.
   */
  trustedAppOrigins?: string[];
  /** Reported by the dashboard, so somebody can see what they are running. */
  version?: string;
  /** The AI gateway every model call goes through; built from `fetchImpl` when absent. */
  gateway?: AiGateway;
  /** How many hops a chain of agent delegations may reach (at most 4). */
  maxDelegationDepth?: number;
  /** Whether admins may connect local (stdio) MCP servers, which run as this process's user. */
  allowMcpStdio?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 1024 * 1024,
    requestIdHeader: 'x-request-id',
  });
  app.decorate('db', opts.db);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: 'invalid_request', issues: error.issues });
      return;
    }
    const candidate = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode)
      : 500;
    const statusCode = Number.isInteger(candidate) && candidate >= 400 && candidate < 500 ? candidate : 500;
    if (statusCode >= 500) request.log.error(error);
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'internal_error' : error instanceof Error ? error.message : 'request_failed',
    });
  });
  /*
   * The hosted app runs on its own origin and talks to every server from
   * there, so a server has to say which origins may read its answers.
   *
   * Sessions are bearer tokens rather than cookies, so nothing is sent by the
   * browser on its own and there is no credentialed mode to open up. An origin
   * that is not on the list gets no header, and the browser refuses to hand it
   * the answer.
   */
  const trustedOrigins = new Set(opts.trustedAppOrigins ?? []);
  const allowedOrigin = (request: { headers: { origin?: string } }): string | undefined => {
    const origin = request.headers.origin;
    return origin && trustedOrigins.has(origin) ? origin : undefined;
  };
  if (trustedOrigins.size > 0) {
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return;
      const origin = allowedOrigin(request);
      reply.header('vary', 'Origin');
      if (!origin) return;
      reply.header('access-control-allow-origin', origin);
      if (request.method !== 'OPTIONS') return;
      reply
        .header('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
        .header('access-control-allow-headers', 'authorization, content-type')
        .header('access-control-max-age', '600')
        .code(204)
        .send();
    });
  }

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    return payload;
  });
  const hub = new ConnectionHub(opts.db);
  app.decorate('hub', hub);
  const deviceHub = new DeviceConnectionHub();
  app.decorate('deviceHub', deviceHub);
  await app.register(websocketPlugin);

  app.get('/api/v1/health', async () => ({ ok: true }));
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => {
    opts.db.prepare('SELECT 1').get();
    return { ready: true };
  });
  registerAuthRoutes(app, {
    setupClaimToken: opts.setupClaimToken,
    onSetupComplete: opts.onSetupComplete,
    cloudHandoff: opts.cloudHandoff,
  });
  registerUserRoutes(app);
  registerServerAdminRoutes(app, { version: opts.version ?? '0.0.0-dev' });
  registerDeviceRoutes(app, deviceHub);
  registerAgentRoutes(app);
  registerConversationRoutes(app);
  const gateway = opts.gateway ?? new AiGateway({
    db: opts.db,
    fetchImpl: opts.fetchImpl ?? globalThis.fetch.bind(globalThis),
    deviceHub,
  });
  app.decorate('gateway', gateway);
  installBudgets(opts.db, gateway, hub, (kind, model, usage) => priceCall(opts.db, kind, model, usage));
  const agentStatus = new AgentStatusBroadcaster(opts.db, hub, () => ({ deviceHub, rateLimits: gateway.rateLimits }));
  app.decorate('agentStatus', agentStatus);
  const runQueue = new AgentRunQueue();
  app.decorate('runQueue', runQueue);
  // A provider failing or recovering moves every agent that uses it.
  gateway.onCall(() => agentStatus.refresh());
  registerUsageRoutes(app);
  registerSecretRoutes(app);
  registerMcpSecretHooks();
  const mcpOptions = {
    fetchImpl: opts.fetchImpl ?? globalThis.fetch.bind(globalThis),
    allowStdio: opts.allowMcpStdio ?? false,
    clientVersion: opts.version,
  };
  registerMcpRoutes(app, mcpOptions);
  registerSkillSecretHooks();
  registerSkillRoutes(app);
  const respond: RespondFn = opts.respond ?? createProviderRespond(opts.db, globalThis.fetch.bind(globalThis), deviceHub, {
    gateway,
    instructions: [skillInstructions(opts.db)],
    toolsets: [
      mcpToolset(opts.db, mcpOptions),
      delegationToolset({
        db: opts.db,
        hub,
        respond: () => respond,
        status: agentStatus,
        queue: runQueue,
        maxDepth: opts.maxDelegationDepth,
      }),
    ],
  });
  registerMessageRoutes(app, hub, respond);
  registerMemoryFactRoutes(app);
  registerConversationSummaryRoutes(app);
  registerProviderRoutes(app, { fetchImpl: opts.fetchImpl });
  registerRuntimeRoutes(app, hub, respond);
  registerRunInspectorRoutes(app, hub);
  registerApprovalRoutes(app);
  registerWsRoutes(app, hub, opts.trustedAppOrigins ?? []);
  registerDeviceSocket(app, deviceHub, hub);

  if (opts.webDir && fs.existsSync(path.join(opts.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: opts.webDir, prefix: '/', index: false });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
