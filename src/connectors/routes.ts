import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { CONNECTOR_CAPABILITIES, CONNECTOR_PROVIDERS, consumeConnectorState, oauthEnvVars, exchangeAsanaCode, exchangeDropboxCode, exchangeGitHubCode, exchangeGitLabCode, exchangeGoogleCalendarCode, exchangeGoogleDriveCode, exchangeGmailCode, exchangeLinearCode, exchangeNotionCode, exchangeSlackCode, asanaRequest, dropboxRequest, githubRequest, gitlabRequest, googleRequest, linearRequest, PROVIDERS, startAsanaAuthorization, startDropboxAuthorization, startGitHubAuthorization, startGitLabAuthorization, startGoogleCalendarAuthorization, startGoogleDriveAuthorization, startGmailAuthorization, startLinearAuthorization, startNotionAuthorization, startSlackAuthorization, ConnectorOAuthError, type ConnectorCapability, type ConnectorOAuthConfig, type ConnectorProvider, type OAuthTokens } from './providers.js';
import { connectConnector, createPendingConnector, restartConnector, getConnector, listConnectorAudit, listConnectorGrants, listConnectors, refreshConnector, revokeConnector, setConnectorGrants } from './service.js';
import { importSlackQuickStart, previewSlackChannels } from './slack-import.js';
import { hasPermission } from '../permissions/roles.js';
import { allowedCallbackUrl } from '../auth/callback-url.js';
import { brokeredProviders, brokeredTokenFetch, startBrokeredAuthorization } from './broker.js';

const CapabilitySchema = z.enum(CONNECTOR_CAPABILITIES as unknown as [string, ...string[]]);
const StartSchema = z.object({
  callbackUrl: z.string().url(),
  scopes: z.array(z.string().min(1).max(80)).max(20).optional(),
  /** Reconnect this connector instead of adding another one. */
  connectorId: z.string().min(1).max(200).optional(),
});
const CompleteSchema = z.object({ state: z.string().min(1).max(256), code: z.string().min(1).max(2048) });
const GrantsSchema = z.object({ grants: z.array(z.object({ granteeType: z.enum(['agent', 'automation', 'integration']), granteeId: z.string().min(1).max(200), capability: CapabilitySchema })).max(500) });

function admin(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): boolean {
  if (hasPermission(app.db, request.user!.id, 'integrations.manage')) return true;
  reply.code(403).send({ error: 'forbidden' }); return false;
}
type ConnectorRouteOptions = { fetchImpl?: typeof fetch; githubOAuth?: ConnectorOAuthConfig; gitlabOAuth?: ConnectorOAuthConfig;
  linearOAuth?: ConnectorOAuthConfig; asanaOAuth?: ConnectorOAuthConfig; notionOAuth?: ConnectorOAuthConfig; googleDriveOAuth?: ConnectorOAuthConfig;
  googleCalendarOAuth?: ConnectorOAuthConfig; gmailOAuth?: ConnectorOAuthConfig; dropboxOAuth?: ConnectorOAuthConfig;
  slackOAuth?: ConnectorOAuthConfig; callbackOrigins?: string[] };

function oauthConfig(options: ConnectorRouteOptions, provider: ConnectorProvider): ConnectorOAuthConfig | undefined {
  const configured = provider === 'github' ? options.githubOAuth
    : provider === 'gitlab' ? options.gitlabOAuth
      : provider === 'linear' ? options.linearOAuth
        : provider === 'asana' ? options.asanaOAuth
          : provider === 'notion' ? options.notionOAuth
            : provider === 'google-drive' ? options.googleDriveOAuth
              : provider === 'google-calendar' ? options.googleCalendarOAuth
                : provider === 'gmail' ? options.gmailOAuth
                  : provider === 'dropbox' ? options.dropboxOAuth : options.slackOAuth;
  if (configured) return configured;
  const env = oauthEnvVars(provider);
  const clientId = process.env[env.clientId];
  const clientSecret = process.env[env.clientSecret];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}
/** Tells the admin exactly what is missing, instead of a bare "not configured". */
function sendNotConfigured(reply: FastifyReply, provider: ConnectorProvider): void {
  const env = oauthEnvVars(provider);
  reply.code(503).send({
    error: 'connector_oauth_not_configured',
    provider,
    message: `${PROVIDERS[provider].label} sign-in is not set up on this server yet. Set ${env.clientId} and ${env.clientSecret}, then restart the server.`,
    missing: [env.clientId, env.clientSecret].filter((name) => !process.env[name]),
  });
}
function sendConnectorError(reply: FastifyReply, error: unknown): void {
  if (error instanceof ConnectorOAuthError) { reply.code(error.statusCode).send({ error: 'connector_oauth_failed', message: error.message }); return; }
  if (error instanceof Error && error.message.startsWith('connector_')) { reply.code(error.message === 'connector_not_found' ? 404 : 409).send({ error: error.message }); return; }
  throw error;
}

export function registerConnectorRoutes(app: FastifyInstance, options: ConnectorRouteOptions = {}): void {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  app.get('/api/v1/connectors/providers', { preHandler: requireAuth }, async (_request, reply) => {
    const brokered = await brokeredProviders(app.db, fetchImpl);
    reply.send({ providers: CONNECTOR_PROVIDERS.map((provider) => {
      const env = oauthEnvVars(provider);
      const local = oauthConfig(options, provider) !== undefined;
      return { provider, label: PROVIDERS[provider].label, description: PROVIDERS[provider].description,
        capabilities: PROVIDERS[provider].capabilities, scopes: PROVIDERS[provider].scopes,
        // Whether an admin can connect it now, and if not, what they have to set.
        configured: local || brokered.has(provider),
        // Signs in through Crewly's own OAuth app: nothing to register here.
        managed: !local && brokered.has(provider),
        setup: { clientIdEnv: env.clientId, clientSecretEnv: env.clientSecret, setupUrl: PROVIDERS[provider].setupUrl } };
    }) });
  });
  app.get('/api/v1/connectors', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return; reply.send({ connectors: listConnectors(app.db) });
  });
  app.post('/api/v1/connectors/oauth/:provider/start', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return;
    const provider = z.enum(CONNECTOR_PROVIDERS).parse((request.params as { provider: string }).provider);
    const local = oauthConfig(options, provider);
    if (!local && !(await brokeredProviders(app.db, fetchImpl)).has(provider)) { sendNotConfigured(reply, provider); return; }
    const body = StartSchema.parse(request.body);
    if (!allowedCallbackUrl(request, body.callbackUrl, options.callbackOrigins ?? [])) { reply.code(400).send({ error: 'invalid_callback_url' }); return; }
    // Through Crewly: its client id and callback, and a state it will send
    // back to the page this sign-in started from.
    let brokered: { state: string; clientId: string; redirectUri: string } | undefined;
    if (!local) {
      try { brokered = await startBrokeredAuthorization(app.db, fetchImpl, provider, body.callbackUrl); }
      catch (error) { sendConnectorError(reply, error); return; }
    }
    const config: ConnectorOAuthConfig = local ?? { clientId: brokered!.clientId, clientSecret: '' };
    const actor = { type: 'user' as const, id: request.user!.id };
    let connectorId: string;
    try {
      connectorId = body.connectorId
        ? restartConnector(app.db, { id: body.connectorId, provider }, actor).id
        : createPendingConnector(app.db, { id: randomUUID(), provider, ownerUserId: request.user!.id }, actor).id;
    } catch (error) { sendConnectorError(reply, error); return; }
    const common = { connectorId, userId: request.user!.id, scopes: body.scopes,
      ...(brokered ? { callbackUrl: brokered.redirectUri, state: brokered.state } : { callbackUrl: body.callbackUrl }) };
    const pending = provider === 'github' ? startGitHubAuthorization(app.db, common, config)
      : provider === 'gitlab' ? startGitLabAuthorization(app.db, common, config)
        : provider === 'linear' ? startLinearAuthorization(app.db, common, config)
          : provider === 'asana' ? startAsanaAuthorization(app.db, common, config)
            : provider === 'notion' ? startNotionAuthorization(app.db, common, config)
              : provider === 'google-drive' ? startGoogleDriveAuthorization(app.db, common, config)
              : provider === 'google-calendar' ? startGoogleCalendarAuthorization(app.db, common, config)
                : provider === 'gmail' ? startGmailAuthorization(app.db, common, config)
                  : provider === 'dropbox' ? startDropboxAuthorization(app.db, common, config)
                    : startSlackAuthorization(app.db, common, config);
    reply.send(pending);
  });
  app.post('/api/v1/connectors/oauth/:provider/complete', { preHandler: requireAuth }, async (request, reply) => {
    if (!admin(app, request, reply)) return;
    const provider = z.enum(CONNECTOR_PROVIDERS).parse((request.params as { provider: string }).provider);
    const local = oauthConfig(options, provider);
    const body = CompleteSchema.parse(request.body);
    try {
      const pending = consumeConnectorState(app.db, { state: body.state, userId: request.user!.id });
      if (pending.provider !== provider) throw new ConnectorOAuthError('this connection attempt is for another provider', 400);
      // Without an OAuth app here, the sign-in went through Crewly, and so
      // does the exchange; the rest -- reading the account -- happens here.
      const config: ConnectorOAuthConfig = local ?? { clientId: '', clientSecret: '' };
      const exchangeFetch = local ? fetchImpl
        : brokeredTokenFetch(app.db, fetchImpl, provider, { state: body.state, code: body.code, codeVerifier: pending.code_verifier });
      let connection: OAuthTokens & { accountId: string; accountName: string; accountUrl?: string; scopes: string[]; metadata?: Record<string, unknown> };
      if (provider === 'github') {
        const tokens = await exchangeGitHubCode({ code: body.code, codeVerifier: pending.code_verifier, redirectUri: pending.callback_url }, config, exchangeFetch);
        const { token } = tokens;
        const profile = await githubRequest(token, '/user', fetchImpl);
        if (profile.status !== 200 || typeof profile.body.id !== 'number') throw new ConnectorOAuthError('GitHub did not return an account', 502);
        connection = { ...tokens, accountId: String(profile.body.id), accountName: String(profile.body.login ?? ''), accountUrl: typeof profile.body.html_url === 'string' ? profile.body.html_url : undefined, scopes: PROVIDERS.github.scopes };
      } else if (provider === 'gitlab') {
        const tokens = await exchangeGitLabCode({ code: body.code, codeVerifier: pending.code_verifier, redirectUri: pending.callback_url }, config, exchangeFetch);
        const { token } = tokens;
        const profile = await gitlabRequest(token, 'user', fetchImpl);
        if (profile.status !== 200 || typeof profile.body.id !== 'number') throw new ConnectorOAuthError('GitLab did not return an account', 502);
        connection = { ...tokens, accountId: String(profile.body.id), accountName: String(profile.body.username ?? profile.body.name ?? ''), accountUrl: typeof profile.body.web_url === 'string' ? profile.body.web_url : undefined, scopes: PROVIDERS.gitlab.scopes };
      } else if (provider === 'linear') {
        const tokens = await exchangeLinearCode({ code: body.code, codeVerifier: pending.code_verifier, redirectUri: pending.callback_url }, config, exchangeFetch);
        const { token } = tokens;
        const profile = await linearRequest(token, 'query Viewer { viewer { id name url } }', {}, fetchImpl);
        const viewer = (profile.body.data as { viewer?: Record<string, unknown> } | undefined)?.viewer;
        if (profile.status !== 200 || !viewer?.id) throw new ConnectorOAuthError('Linear did not return a workspace account', 502);
        connection = { ...tokens, accountId: String(viewer.id), accountName: String(viewer.name ?? 'Linear'), accountUrl: typeof viewer.url === 'string' ? viewer.url : undefined, scopes: PROVIDERS.linear.scopes };
      } else if (provider === 'asana') {
        const tokens = await exchangeAsanaCode({ code: body.code, codeVerifier: pending.code_verifier, redirectUri: pending.callback_url }, config, exchangeFetch);
        const { token } = tokens;
        const profile = await asanaRequest(token, 'users/me', fetchImpl);
        const user = profile.body.data as Record<string, unknown> | undefined;
        if (profile.status !== 200 || typeof user?.gid !== 'string') throw new ConnectorOAuthError('Asana did not return an account', 502);
        connection = { ...tokens, accountId: user.gid, accountName: String(user.name ?? user.email ?? 'Asana'), accountUrl: 'https://app.asana.com', scopes: PROVIDERS.asana.scopes };
      } else if (provider === 'notion') {
        const notion = await exchangeNotionCode({ code: body.code, redirectUri: pending.callback_url }, config, exchangeFetch);
        connection = { token: notion.token, accountId: notion.workspaceId, accountName: notion.workspaceName,
          accountUrl: 'https://www.notion.so', scopes: PROVIDERS.notion.scopes, metadata: { botId: notion.botId, workspaceIcon: notion.workspaceIcon } };
      } else if (provider === 'google-drive') {
        const tokens = await exchangeGoogleDriveCode({ code: body.code, codeVerifier: pending.code_verifier, redirectUri: pending.callback_url }, config, exchangeFetch);
        const { token } = tokens;
        const profile = await googleRequest(token, 'https://www.googleapis.com/oauth2/v3/userinfo', fetchImpl);
        if (profile.status !== 200 || typeof profile.body.sub !== 'string') throw new ConnectorOAuthError('Google did not return an account', 502);
        connection = { ...tokens, accountId: profile.body.sub, accountName: String(profile.body.name ?? profile.body.email ?? 'Google Drive'), accountUrl: 'https://drive.google.com', scopes: PROVIDERS['google-drive'].scopes };
      } else if (provider === 'google-calendar') {
        const tokens = await exchangeGoogleCalendarCode({ code: body.code, codeVerifier: pending.code_verifier, redirectUri: pending.callback_url }, config, exchangeFetch);
        const { token } = tokens;
        const profile = await googleRequest(token, 'https://www.googleapis.com/oauth2/v3/userinfo', fetchImpl);
        if (profile.status !== 200 || typeof profile.body.sub !== 'string') throw new ConnectorOAuthError('Google did not return an account', 502);
        connection = { ...tokens, accountId: profile.body.sub, accountName: String(profile.body.name ?? profile.body.email ?? 'Google Calendar'), accountUrl: 'https://calendar.google.com', scopes: PROVIDERS['google-calendar'].scopes };
      } else if (provider === 'gmail') {
        const tokens = await exchangeGmailCode({ code: body.code, codeVerifier: pending.code_verifier, redirectUri: pending.callback_url }, config, exchangeFetch);
        const { token } = tokens;
        const profile = await googleRequest(token, 'https://www.googleapis.com/oauth2/v3/userinfo', fetchImpl);
        if (profile.status !== 200 || typeof profile.body.sub !== 'string') throw new ConnectorOAuthError('Google did not return an account', 502);
        connection = { ...tokens, accountId: profile.body.sub, accountName: String(profile.body.name ?? profile.body.email ?? 'Gmail'), accountUrl: 'https://mail.google.com', scopes: PROVIDERS.gmail.scopes };
      } else if (provider === 'dropbox') {
        const tokens = await exchangeDropboxCode({ code: body.code, codeVerifier: pending.code_verifier, redirectUri: pending.callback_url }, config, exchangeFetch);
        const { token } = tokens;
        const profile = await dropboxRequest(token, 'users/get_current_account', fetchImpl, { method: 'POST', body: '{}' });
        if (profile.status !== 200 || typeof profile.body.account_id !== 'string') throw new ConnectorOAuthError('Dropbox did not return an account', 502);
        const name = profile.body.name as Record<string, unknown> | undefined;
        connection = { ...tokens, accountId: profile.body.account_id, accountName: String(name?.display_name ?? profile.body.email ?? 'Dropbox'), accountUrl: 'https://www.dropbox.com/home', scopes: PROVIDERS.dropbox.scopes };
      } else {
        const slack = await exchangeSlackCode({ code: body.code, redirectUri: pending.callback_url }, config, exchangeFetch);
        connection = { token: slack.token, accountId: slack.teamId, accountName: slack.teamName, accountUrl: `https://app.slack.com/client/${slack.teamId}`, scopes: slack.scopes };
      }
      reply.code(201).send(connectConnector(app.db, pending.connector_id, { ...connection, oauthApp: local ? 'local' : 'crewly' }, { type: 'user', id: request.user!.id }));
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
    try { reply.send(await refreshConnector(app.db, id, { type: 'user', id: request.user!.id }, fetchImpl, (provider) => oauthConfig(options, provider))); } catch (error) { sendConnectorError(reply, error); }
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
