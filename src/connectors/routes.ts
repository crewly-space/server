import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { CONNECTOR_CAPABILITIES, CONNECTOR_PROVIDERS, consumeConnectorState, exchangeGitHubCode, exchangeLinearCode, exchangeSlackCode, githubRequest, linearRequest, PROVIDERS, startGitHubAuthorization, startLinearAuthorization, startSlackAuthorization, ConnectorOAuthError, type ConnectorCapability, type ConnectorOAuthConfig } from './providers.js';
import { connectConnector, createPendingConnector, getConnector, listConnectorAudit, listConnectorGrants, listConnectors, refreshConnector, revokeConnector, setConnectorGrants } from './service.js';
import { importSlackQuickStart, previewSlackChannels } from './slack-import.js';
import { hasPermission } from '../permissions/roles.js';

const CapabilitySchema = z.enum(CONNECTOR_CAPABILITIES as unknown as [string, ...string[]]);
const StartSchema = z.object({ callbackUrl: z.string().url(), scopes: z.array(z.string().min(1).max(80)).max(20).optional() });
const CompleteSchema = z.object({ state: z.string().min(1).max(256), code: z.string().min(1).max(2048) });
const GrantsSchema = z.object({ grants: z.array(z.object({ granteeType: z.enum(['agent', 'automation', 'integration']), granteeId: z.string().min(1).max(200), capability: CapabilitySchema })).max(500) });

function admin(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): boolean {
  if (hasPermission(app.db, request.user!.id, 'integrations.manage')) return true;
  reply.code(403).send({ error: 'forbidden' }); return false;
}
function oauthConfig(options: { githubOAuth?: ConnectorOAuthConfig; linearOAuth?: ConnectorOAuthConfig; slackOAuth?: ConnectorOAuthConfig }, provider: 'github' | 'linear' | 'slack'): ConnectorOAuthConfig | undefined {
  const configured = provider === 'github' ? options.githubOAuth : provider === 'linear' ? options.linearOAuth : options.slackOAuth;
  if (configured) return configured;
  const prefix = provider === 'github' ? 'GITHUB' : provider === 'linear' ? 'LINEAR' : 'SLACK';
  const clientId = process.env[`CREWLY_${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`CREWLY_${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}
function sendConnectorError(reply: FastifyReply, error: unknown): void {
  if (error instanceof ConnectorOAuthError) { reply.code(error.statusCode).send({ error: 'connector_oauth_failed', message: error.message }); return; }
  if (error instanceof Error && error.message.startsWith('connector_')) { reply.code(error.message === 'connector_not_found' ? 404 : 409).send({ error: error.message }); return; }
  throw error;
}

export function registerConnectorRoutes(app: FastifyInstance, options: { fetchImpl?: typeof fetch; githubOAuth?: ConnectorOAuthConfig; linearOAuth?: ConnectorOAuthConfig; slackOAuth?: ConnectorOAuthConfig } = {}): void {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  app.get('/api/v1/connectors/providers', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send({ providers: CONNECTOR_PROVIDERS.map((provider) => ({ provider, label: PROVIDERS[provider].label, description: PROVIDERS[provider].description, capabilities: PROVIDERS[provider].capabilities, scopes: PROVIDERS[provider].scopes })) });
  });
  app.get('/api/v1/connectors', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return; reply.send({ connectors: listConnectors(app.db) });
  });
  app.post('/api/v1/connectors/oauth/github/start', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return;
    const config = oauthConfig(options, 'github'); if (!config) { reply.code(503).send({ error: 'connector_oauth_not_configured' }); return; }
    const body = StartSchema.parse(request.body); const connectorId = randomUUID();
    createPendingConnector(app.db, { id: connectorId, provider: 'github', ownerUserId: request.user!.id }, { type: 'user', id: request.user!.id });
    reply.send(startGitHubAuthorization(app.db, { connectorId, userId: request.user!.id, callbackUrl: body.callbackUrl, scopes: body.scopes }, config));
  });
  app.post('/api/v1/connectors/oauth/github/complete', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return;
    const config = oauthConfig(options, 'github'); if (!config) { reply.code(503).send({ error: 'connector_oauth_not_configured' }); return; }
    const body = CompleteSchema.parse(request.body);
    try {
      const pending = consumeConnectorState(app.db, { state: body.state, userId: request.user!.id });
      const token = await exchangeGitHubCode({ code: body.code, codeVerifier: pending.code_verifier, redirectUri: pending.callback_url }, config, fetchImpl);
      const profile = await githubRequest(token, '/user', fetchImpl);
      if (profile.status !== 200 || typeof profile.body.id !== 'number') throw new ConnectorOAuthError('GitHub did not return an account', 502);
      reply.code(201).send(connectConnector(app.db, pending.connector_id, { token, accountId: String(profile.body.id), accountName: String(profile.body.login ?? ''), accountUrl: typeof profile.body.html_url === 'string' ? profile.body.html_url : undefined, scopes: ['read:user', 'repo'] }, { type: 'user', id: request.user!.id }));
    } catch (error) { sendConnectorError(reply, error); }
  });
  app.post('/api/v1/connectors/oauth/linear/start', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return;
    const config = oauthConfig(options, 'linear'); if (!config) { reply.code(503).send({ error: 'connector_oauth_not_configured' }); return; }
    const body = StartSchema.parse(request.body); const connectorId = randomUUID();
    createPendingConnector(app.db, { id: connectorId, provider: 'linear', ownerUserId: request.user!.id }, { type: 'user', id: request.user!.id });
    reply.send(startLinearAuthorization(app.db, { connectorId, userId: request.user!.id, callbackUrl: body.callbackUrl, scopes: body.scopes }, config));
  });
  app.post('/api/v1/connectors/oauth/linear/complete', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return;
    const config = oauthConfig(options, 'linear'); if (!config) { reply.code(503).send({ error: 'connector_oauth_not_configured' }); return; }
    const body = CompleteSchema.parse(request.body);
    try {
      const pending = consumeConnectorState(app.db, { state: body.state, userId: request.user!.id });
      if (pending.provider !== 'linear') throw new ConnectorOAuthError('this connection attempt is for another provider', 400);
      const token = await exchangeLinearCode({ code: body.code, codeVerifier: pending.code_verifier, redirectUri: pending.callback_url }, config, fetchImpl);
      const profile = await linearRequest(token, 'query Viewer { viewer { id name url } }', {}, fetchImpl);
      const viewer = (profile.body.data as { viewer?: Record<string, unknown> } | undefined)?.viewer;
      if (profile.status !== 200 || !viewer?.id) throw new ConnectorOAuthError('Linear did not return a workspace account', 502);
      reply.code(201).send(connectConnector(app.db, pending.connector_id, { token, accountId: String(viewer.id), accountName: String(viewer.name ?? 'Linear'), accountUrl: typeof viewer.url === 'string' ? viewer.url : undefined, scopes: PROVIDERS.linear.scopes }, { type: 'user', id: request.user!.id }));
    } catch (error) { sendConnectorError(reply, error); }
  });
  app.post('/api/v1/connectors/oauth/slack/start', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return;
    const config = oauthConfig(options, 'slack'); if (!config) { reply.code(503).send({ error: 'connector_oauth_not_configured' }); return; }
    const body = StartSchema.parse(request.body); const connectorId = randomUUID();
    createPendingConnector(app.db, { id: connectorId, provider: 'slack', ownerUserId: request.user!.id }, { type: 'user', id: request.user!.id });
    reply.send(startSlackAuthorization(app.db, { connectorId, userId: request.user!.id, callbackUrl: body.callbackUrl, scopes: body.scopes }, config));
  });
  app.post('/api/v1/connectors/oauth/slack/complete', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return;
    const config = oauthConfig(options, 'slack'); if (!config) { reply.code(503).send({ error: 'connector_oauth_not_configured' }); return; }
    const body = CompleteSchema.parse(request.body);
    try {
      const pending = consumeConnectorState(app.db, { state: body.state, userId: request.user!.id });
      if (pending.provider !== 'slack') throw new ConnectorOAuthError('this connection attempt is for another provider', 400);
      const slack = await exchangeSlackCode({ code: body.code, redirectUri: pending.callback_url }, config, fetchImpl);
      reply.code(201).send(connectConnector(app.db, pending.connector_id, { token: slack.token, accountId: slack.teamId, accountName: slack.teamName,
        accountUrl: `https://app.slack.com/client/${slack.teamId}`, scopes: slack.scopes }, { type: 'user', id: request.user!.id }));
    } catch (error) { sendConnectorError(reply, error); }
  });
  app.get('/api/v1/connectors/:id/slack/channels', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return;
    try { reply.send({ channels: await previewSlackChannels(app.db, (request.params as { id: string }).id, fetchImpl) }); }
    catch (error) { sendConnectorError(reply, error); }
  });
  app.post('/api/v1/connectors/:id/slack/import', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return;
    const body = z.object({ channelIds: z.array(z.string().min(1)).min(1).max(100), historyLimit: z.number().int().min(0).max(100).default(0), importMembers: z.boolean().default(false) }).parse(request.body);
    try { reply.code(201).send(await importSlackQuickStart(app.db, { connectorId: (request.params as { id: string }).id, ...body,
      requestedBy: request.user!.id, role: request.user!.role === 'owner' ? 'owner' : 'admin' }, fetchImpl)); }
    catch (error) { sendConnectorError(reply, error); }
  });
  app.post('/api/v1/connectors/:id/refresh', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return; const { id } = request.params as { id: string };
    try { reply.send(await refreshConnector(app.db, id, { type: 'user', id: request.user!.id }, fetchImpl)); } catch (error) { sendConnectorError(reply, error); }
  });
  app.post('/api/v1/connectors/:id/revoke', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return; const { id } = request.params as { id: string };
    const connector = revokeConnector(app.db, id, { type: 'user', id: request.user!.id }); if (!connector) { reply.code(404).send({ error: 'connector_not_found' }); return; } reply.send(connector);
  });
  app.get('/api/v1/connectors/:id/grants', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return; const { id } = request.params as { id: string }; if (!getConnector(app.db, id)) { reply.code(404).send({ error: 'connector_not_found' }); return; } reply.send({ grants: listConnectorGrants(app.db, id) });
  });
  app.put('/api/v1/connectors/:id/grants', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return; const { id } = request.params as { id: string };
    try { reply.send({ grants: setConnectorGrants(app.db, id, GrantsSchema.parse(request.body).grants as Array<{ granteeType: 'agent' | 'automation' | 'integration'; granteeId: string; capability: ConnectorCapability }>, { type: 'user', id: request.user!.id }) }); } catch (error) { sendConnectorError(reply, error); }
  });
  app.get('/api/v1/connectors/:id/audit', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return; const { id } = request.params as { id: string }; if (!getConnector(app.db, id)) { reply.code(404).send({ error: 'connector_not_found' }); return; }
    const limit = z.coerce.number().int().positive().max(500).default(100).parse((request.query as { limit?: string }).limit); reply.send({ entries: listConnectorAudit(app.db, id, limit) });
  });
}
