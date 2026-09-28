import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { fetchPublicHttps, parsePublicHttpsUrl } from '../security/outbound.js';
import { McpError } from './client.js';
import { getMcpServer, saveMcpOAuth, type McpOAuthState, type McpServerRecord } from './repository.js';

/**
 * Signing an MCP server in with OAuth, as the MCP authorization spec
 * describes it: find the authorization server from the resource's protected
 * resource metadata (RFC 9728), read its metadata (RFC 8414), register
 * Crewly as a client when it allows dynamic registration (RFC 7591), and run
 * an authorization-code flow with PKCE, naming the resource (RFC 8707).
 *
 * Tokens are stored encrypted with the server and attached by the tool
 * runtime at call time. The model never sees them, and neither does the API.
 */

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 60_000;

type Fetch = typeof fetch | undefined;

async function getJson(url: string, fetchImpl: Fetch): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetchPublicHttps(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }, fetchImpl);
    if (!response.ok) return undefined;
    const body = await response.json() as unknown;
    return body && typeof body === 'object' ? body as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function wellKnown(base: URL, name: string): string[] {
  const path = base.pathname.replace(/\/+$/, '');
  return [...new Set([`${base.origin}/.well-known/${name}${path}`, `${base.origin}/.well-known/${name}`])];
}

/** Where the MCP server says its authorization server is. */
async function protectedResource(serverUrl: string, fetchImpl: Fetch): Promise<{ resource: string; authorizationServer: string; scopes?: string[] }> {
  const url = parsePublicHttpsUrl(serverUrl);
  let metadataUrl: string | undefined;
  try {
    // An unauthenticated request should be refused with a pointer to the metadata.
    const probe = await fetchPublicHttps(url.toString(), {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'crewly', version: '0' } } }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    }, fetchImpl);
    const header = probe.headers.get('www-authenticate') ?? '';
    metadataUrl = /resource_metadata="([^"]+)"/i.exec(header)?.[1];
  } catch {
    // Fall back to the well-known locations.
  }
  for (const candidate of metadataUrl ? [metadataUrl] : wellKnown(url, 'oauth-protected-resource')) {
    const metadata = await getJson(candidate, fetchImpl);
    const servers = metadata?.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === 'string') {
      return {
        resource: typeof metadata!.resource === 'string' ? metadata!.resource : url.toString(),
        authorizationServer: servers[0],
        scopes: Array.isArray(metadata!.scopes_supported) ? metadata!.scopes_supported.filter((scope): scope is string => typeof scope === 'string') : undefined,
      };
    }
  }
  // Servers from before protected resource metadata act as their own authorization server.
  return { resource: url.toString(), authorizationServer: url.origin };
}

async function authorizationServerMetadata(issuer: string, fetchImpl: Fetch): Promise<Record<string, unknown>> {
  const base = parsePublicHttpsUrl(issuer);
  for (const candidate of [...wellKnown(base, 'oauth-authorization-server'), ...wellKnown(base, 'openid-configuration')]) {
    const metadata = await getJson(candidate, fetchImpl);
    if (metadata && typeof metadata.authorization_endpoint === 'string' && typeof metadata.token_endpoint === 'string') return metadata;
  }
  throw new McpError('oauth_unsupported', `${base.host} does not publish OAuth authorization server metadata. Use a token in a header instead.`);
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function startMcpOAuth(db: Database, server: McpServerRecord, input: { userId: string; redirectUri: string; fetchImpl?: typeof fetch }): Promise<{ authorizationUrl: string; state: string }> {
  if (server.transport !== 'http' || !server.url) throw new McpError('oauth_unsupported', 'Only remote MCP servers sign in with OAuth.');
  const resource = await protectedResource(server.url, input.fetchImpl);
  const metadata = await authorizationServerMetadata(resource.authorizationServer, input.fetchImpl);
  const authorizationEndpoint = String(metadata.authorization_endpoint);
  const tokenEndpoint = String(metadata.token_endpoint);
  parsePublicHttpsUrl(authorizationEndpoint);
  parsePublicHttpsUrl(tokenEndpoint);
  const registrationEndpoint = typeof metadata.registration_endpoint === 'string' ? metadata.registration_endpoint : undefined;
  const scope = resource.scopes?.join(' ') || undefined;

  // A client registered for this server and redirect is reused; a new redirect needs a new registration.
  let client = server.oauth && server.oauth.tokenEndpoint === tokenEndpoint && server.oauth.clientId
    ? { clientId: server.oauth.clientId, clientSecret: server.oauth.clientSecret } : undefined;
  if (!client || server.oauth?.redirectUri !== input.redirectUri) {
    if (!registrationEndpoint) {
      throw new McpError('oauth_registration_unsupported', `${new URL(authorizationEndpoint).host} does not allow dynamic client registration, so Crewly cannot sign in to it automatically. Use a token in a header instead.`);
    }
    const response = await fetchPublicHttps(registrationEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ client_name: 'Crewly', redirect_uris: [input.redirectUri], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) }),
    }, input.fetchImpl);
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || typeof body.client_id !== 'string') throw new McpError('oauth_registration_failed', `Registering Crewly with ${new URL(registrationEndpoint).host} failed (${response.status}).`);
    client = { clientId: body.client_id, clientSecret: typeof body.client_secret === 'string' ? body.client_secret : undefined };
  }

  const oauth: McpOAuthState = {
    ...(server.oauth ?? {}),
    issuer: typeof metadata.issuer === 'string' ? metadata.issuer : resource.authorizationServer,
    authorizationEndpoint, tokenEndpoint, registrationEndpoint, resource: resource.resource, scope,
    clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: input.redirectUri,
  };
  saveMcpOAuth(db, server.id, oauth);

  const { verifier, challenge } = pkce();
  const state = randomBytes(24).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM mcp_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO mcp_oauth_states (state, server_id, code_verifier, user_id, redirect_uri, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(state, server.id, verifier, input.userId, input.redirectUri, new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());

  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', resource.resource);
  if (scope) url.searchParams.set('scope', scope);
  return { authorizationUrl: url.toString(), state };
}

async function tokenRequest(oauth: McpOAuthState, params: Record<string, string>, fetchImpl: Fetch): Promise<McpOAuthState> {
  const form = new URLSearchParams({ ...params, client_id: oauth.clientId, resource: oauth.resource });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (oauth.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(oauth.clientSecret)}`).toString('base64')}`;
  const response = await fetchPublicHttps(oauth.tokenEndpoint, { method: 'POST', headers, body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(15_000) }, fetchImpl);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== 'string') {
    const reason = typeof body.error === 'string' ? body.error : String(response.status);
    throw new McpError(params.grant_type === 'refresh_token' ? 'oauth_expired' : 'oauth_failed',
      params.grant_type === 'refresh_token' ? `The sign-in expired and could not be renewed (${reason}). Sign in again.` : `Signing in failed (${reason}).`);
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined;
  return {
    ...oauth,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : oauth.refreshToken,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    scope: typeof body.scope === 'string' ? body.scope : oauth.scope,
  };
}

export async function completeMcpOAuth(db: Database, input: { state: string; code: string; userId: string; fetchImpl?: typeof fetch }): Promise<McpServerRecord> {
  const pending = db.prepare('SELECT * FROM mcp_oauth_states WHERE state = ?').get(input.state) as
    { state: string; server_id: string; code_verifier: string; user_id: string; redirect_uri: string; expires_at: string } | undefined;
  // Single use, whatever happens next.
  db.prepare('DELETE FROM mcp_oauth_states WHERE state = ?').run(input.state);
  if (!pending || pending.user_id !== input.userId) throw new McpError('oauth_state_invalid', 'This sign-in link is not valid. Start again.');
  if (pending.expires_at <= new Date().toISOString()) throw new McpError('oauth_state_expired', 'This sign-in took too long. Start again.');
  const server = getMcpServer(db, pending.server_id);
  if (!server?.oauth) throw new McpError('oauth_state_invalid', 'That MCP server is no longer waiting for a sign-in.');
  const next = await tokenRequest(server.oauth, { grant_type: 'authorization_code', code: input.code, redirect_uri: pending.redirect_uri, code_verifier: pending.code_verifier }, input.fetchImpl);
  saveMcpOAuth(db, server.id, next);
  return getMcpServer(db, server.id)!;
}

/** A current access token for the server, renewing it first when it is about to expire. */
export async function mcpAccessToken(db: Database, server: McpServerRecord, fetchImpl?: typeof fetch): Promise<string | undefined> {
  const oauth = server.oauth;
  if (!oauth?.accessToken) return undefined;
  const expiring = oauth.expiresAt && Date.parse(oauth.expiresAt) - Date.now() < REFRESH_MARGIN_MS;
  if (!expiring) return oauth.accessToken;
  if (!oauth.refreshToken) throw new McpError('oauth_expired', `${server.name}'s sign-in has expired. Sign in again.`);
  const next = await tokenRequest(oauth, { grant_type: 'refresh_token', refresh_token: oauth.refreshToken }, fetchImpl);
  saveMcpOAuth(db, server.id, next);
  return next.accessToken;
}

export function signOutMcpOAuth(db: Database, server: McpServerRecord): void {
  if (!server.oauth) return;
  const { accessToken: _a, refreshToken: _r, expiresAt: _e, ...client } = server.oauth;
  saveMcpOAuth(db, server.id, client);
}
