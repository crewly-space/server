import websocketPlugin from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from './db/driver.js';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { registerAgentRoutes } from './agents/routes.js';
import { registerApprovalRoutes } from './approvals/routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerConversationRoutes } from './conversations/routes.js';
import { registerMessageRoutes } from './messages/routes.js';
import { registerConversationSummaryRoutes, registerMemoryFactRoutes } from './memory/routes.js';
import { registerProviderRoutes } from './providers/routes.js';
import { type RespondFn } from './runtime/engine.js';
import { createProviderRespond } from './providers/respond.js';
import { registerRuntimeRoutes } from './runtime/routes.js';
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
  });
  registerUserRoutes(app);
  registerDeviceRoutes(app, deviceHub);
  registerAgentRoutes(app);
  registerConversationRoutes(app);
  const respond = opts.respond ?? createProviderRespond(opts.db, globalThis.fetch.bind(globalThis), deviceHub);
  registerMessageRoutes(app, hub, respond);
  registerMemoryFactRoutes(app);
  registerConversationSummaryRoutes(app);
  registerProviderRoutes(app, { fetchImpl: opts.fetchImpl });
  registerRuntimeRoutes(app, hub, respond);
  registerApprovalRoutes(app);
  registerWsRoutes(app, hub);
  registerDeviceSocket(app, deviceHub);

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
