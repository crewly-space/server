import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/driver.js';

export const CONNECTOR_PROVIDERS = ['github', 'linear'] as const;
export type ConnectorProvider = typeof CONNECTOR_PROVIDERS[number];
export const CONNECTOR_CAPABILITIES = [
  'read_profile',
  'read_repository',
  'read_issues',
  'create_issue',
  'comment_on_pull_request',
  'read_projects',
  'comment_on_issue',
] as const;
export type ConnectorCapability = typeof CONNECTOR_CAPABILITIES[number];
export const CONNECTOR_STATUSES = [
  'pending', 'connected', 'action_required', 'permission_revoked',
  'rate_limited', 'provider_unavailable', 'revoked',
] as const;
export type ConnectorStatus = typeof CONNECTOR_STATUSES[number];

export interface ConnectorProviderDefinition {
  provider: ConnectorProvider;
  label: string;
  description: string;
  capabilities: ConnectorCapability[];
  scopes: string[];
}

export const PROVIDERS: Record<ConnectorProvider, ConnectorProviderDefinition> = {
  github: {
    provider: 'github',
    label: 'GitHub',
    description: 'Repositories, issues and pull requests through a GitHub OAuth app.',
    capabilities: [...CONNECTOR_CAPABILITIES],
    scopes: ['read:user', 'repo'],
  },
  linear: {
    provider: 'linear',
    label: 'Linear',
    description: 'Issues, projects and workflow updates through a Linear workspace connection.',
    capabilities: ['read_issues', 'read_projects', 'create_issue', 'comment_on_issue'],
    scopes: ['read', 'write'],
  },
};

const STATE_TTL_MS = 10 * 60 * 1000;
const base64Url = (input: Buffer): string => input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface PendingConnectorAuthorization {
  connectorId: string;
  state: string;
  authorizeUrl: string;
}

export interface ConnectorOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export class ConnectorOAuthError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export function startGitHubAuthorization(
  db: Database,
  input: { connectorId: string; userId: string; callbackUrl: string; scopes?: string[] },
  config: ConnectorOAuthConfig,
): PendingConnectorAuthorization {
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const now = Date.now();
  db.prepare('DELETE FROM connector_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO connector_oauth_states
    (state, connector_id, provider, code_verifier, user_id, callback_url, created_at, expires_at)
    VALUES (?, ?, 'github', ?, ?, ?, ?, ?)`)
    .run(state, input.connectorId, codeVerifier, input.userId, input.callbackUrl,
      new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('scope', (input.scopes ?? PROVIDERS.github.scopes).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { connectorId: input.connectorId, state, authorizeUrl: url.toString() };
}

export function startLinearAuthorization(
  db: Database,
  input: { connectorId: string; userId: string; callbackUrl: string; scopes?: string[] },
  config: ConnectorOAuthConfig,
): PendingConnectorAuthorization {
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const now = Date.now();
  db.prepare('DELETE FROM connector_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO connector_oauth_states
    (state, connector_id, provider, code_verifier, user_id, callback_url, created_at, expires_at)
    VALUES (?, ?, 'linear', ?, ?, ?, ?, ?)`)
    .run(state, input.connectorId, codeVerifier, input.userId, input.callbackUrl,
      new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  const url = new URL('https://linear.app/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.scopes ?? PROVIDERS.linear.scopes).join(','));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { connectorId: input.connectorId, state, authorizeUrl: url.toString() };
}

interface OAuthStateRow {
  state: string; connector_id: string; provider: string; code_verifier: string;
  user_id: string; callback_url: string; expires_at: string;
}

export function consumeConnectorState(db: Database, input: { state: string; userId: string }): OAuthStateRow {
  const row = db.prepare('SELECT * FROM connector_oauth_states WHERE state = ?').get(input.state) as OAuthStateRow | undefined;
  if (row) db.prepare('DELETE FROM connector_oauth_states WHERE state = ?').run(input.state);
  if (!row || row.user_id !== input.userId || new Date(row.expires_at).getTime() <= Date.now()) {
    throw new ConnectorOAuthError('this connection attempt is no longer valid', 400);
  }
  const provided = Buffer.from(input.state);
  const stored = Buffer.from(row.state);
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) {
    throw new ConnectorOAuthError('this connection attempt is no longer valid', 400);
  }
  return row;
}

export async function exchangeGitHubCode(
  input: { code: string; codeVerifier: string; redirectUri: string },
  config: ConnectorOAuthConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret,
        code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ConnectorOAuthError('GitHub could not be reached', 502); }
  const body = await response.json().catch(() => ({})) as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new ConnectorOAuthError(body.error_description ?? 'GitHub rejected the authorization', 502);
  return body.access_token;
}

export async function exchangeLinearCode(
  input: { code: string; codeVerifier: string; redirectUri: string },
  config: ConnectorOAuthConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl('https://api.linear.app/oauth/token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: input.redirectUri, code: input.code, code_verifier: input.codeVerifier, grant_type: 'authorization_code' }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ConnectorOAuthError('Linear could not be reached', 502); }
  const body = await response.json().catch(() => ({})) as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new ConnectorOAuthError(body.error_description ?? 'Linear rejected the authorization', 502);
  return body.access_token;
}

export async function githubRequest(
  token: string,
  path: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, 'https://api.github.com'), {
      ...init,
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ConnectorOAuthError('GitHub could not be reached', 502); }
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown>, headers: response.headers };
}

export async function linearRequest(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  let response: Response;
  try {
    response = await fetchImpl('https://api.linear.app/graphql', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }), redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ConnectorOAuthError('Linear could not be reached', 502); }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok && Array.isArray(body.errors) && body.errors.length) return { status: 502, body, headers: response.headers };
  return { status: response.status, body, headers: response.headers };
}
