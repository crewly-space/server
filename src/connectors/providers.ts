import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/driver.js';

export const CONNECTOR_PROVIDERS = [
  'github', 'gitlab', 'linear', 'asana', 'notion', 'google-drive', 'google-calendar', 'gmail', 'dropbox', 'slack',
] as const;
export type ConnectorProvider = typeof CONNECTOR_PROVIDERS[number];
export const CONNECTOR_CAPABILITIES = [
  'read_profile',
  'read_repository',
  'read_issues',
  'create_issue',
  'comment_on_pull_request',
  'read_projects',
  'comment_on_issue',
  'read_channels',
  'read_messages',
  'post_messages',
  'read_pages',
  'search_pages',
  'create_page',
  'comment_on_page',
  'read_files',
  'search_files',
  'create_file',
  'read_calendar',
  'read_events',
  'create_event',
  'update_event',
  'delete_event',
  'read_email',
  'search_email',
  'send_email',
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
  /** Where an admin registers the OAuth app this server signs in with. */
  setupUrl: string;
}

export const PROVIDERS: Record<ConnectorProvider, ConnectorProviderDefinition> = {
  github: {
    provider: 'github',
    label: 'GitHub',
    description: 'Repositories, issues and pull requests through a GitHub OAuth app.',
    capabilities: ['read_profile', 'read_repository', 'read_issues', 'create_issue', 'comment_on_pull_request'],
    scopes: ['read:user', 'repo'],
    setupUrl: 'https://github.com/settings/applications/new',
  },
  gitlab: {
    provider: 'gitlab',
    label: 'GitLab',
    description: 'Projects, issues and merge requests through a GitLab OAuth application.',
    capabilities: ['read_profile', 'read_repository', 'read_issues', 'create_issue', 'comment_on_issue', 'comment_on_pull_request'],
    scopes: ['read_user', 'api'],
    setupUrl: 'https://gitlab.com/-/user_settings/applications',
  },
  linear: {
    provider: 'linear',
    label: 'Linear',
    description: 'Issues, projects and workflow updates through a Linear workspace connection.',
    capabilities: ['read_issues', 'read_projects', 'create_issue', 'comment_on_issue'],
    scopes: ['read', 'write'],
    setupUrl: 'https://linear.app/settings/api/applications/new',
  },
  asana: {
    provider: 'asana',
    label: 'Asana',
    description: 'Projects, tasks and comments through an Asana OAuth application.',
    capabilities: ['read_profile', 'read_projects', 'read_issues', 'create_issue', 'comment_on_issue'],
    scopes: ['users:read', 'projects:read', 'tasks:read', 'tasks:write', 'stories:write'],
    setupUrl: 'https://app.asana.com/0/my-apps',
  },
  notion: {
    provider: 'notion',
    label: 'Notion',
    description: 'Search, read and create pages shared with a Notion public integration.',
    capabilities: ['read_profile', 'search_pages', 'read_pages', 'create_page', 'comment_on_page'],
    scopes: [],
    setupUrl: 'https://www.notion.so/profile/integrations',
  },
  'google-drive': {
    provider: 'google-drive',
    label: 'Google Drive',
    description: 'Search, read and create files through a Google OAuth application.',
    capabilities: ['read_profile', 'search_files', 'read_files', 'create_file'],
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'],
    setupUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  'google-calendar': {
    provider: 'google-calendar',
    label: 'Google Calendar',
    description: 'Calendars and events through a Google OAuth application.',
    capabilities: ['read_profile', 'read_calendar', 'read_events', 'create_event', 'update_event', 'delete_event'],
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.events'],
    setupUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  gmail: {
    provider: 'gmail',
    label: 'Gmail',
    description: 'Search, read and send email through a Google OAuth application.',
    capabilities: ['read_profile', 'read_email', 'search_email', 'send_email'],
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    setupUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  dropbox: {
    provider: 'dropbox',
    label: 'Dropbox',
    description: 'Search, read and upload files through a Dropbox OAuth application.',
    capabilities: ['read_profile', 'search_files', 'read_files', 'create_file'],
    scopes: ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write'],
    setupUrl: 'https://www.dropbox.com/developers/apps/create',
  },
  slack: {
    provider: 'slack',
    label: 'Slack',
    description: 'Selected channels, messages, and optional QuickStart import from a Slack workspace.',
    capabilities: ['read_profile', 'read_channels', 'read_messages', 'post_messages'],
    scopes: ['team:read', 'channels:read', 'groups:read', 'channels:history', 'groups:history', 'chat:write', 'users:read', 'users:read.email'],
    setupUrl: 'https://api.slack.com/apps?new_app=1',
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

/** The environment variables that hold a provider's OAuth app credentials. */
export function oauthEnvVars(provider: ConnectorProvider): { clientId: string; clientSecret: string } {
  const prefix = provider.replaceAll('-', '_').toUpperCase();
  return { clientId: `CREWLY_${prefix}_CLIENT_ID`, clientSecret: `CREWLY_${prefix}_CLIENT_SECRET` };
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

export function startAsanaAuthorization(
  db: Database,
  input: { connectorId: string; userId: string; callbackUrl: string; scopes?: string[] },
  config: ConnectorOAuthConfig,
): PendingConnectorAuthorization {
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const now = Date.now();
  db.prepare('DELETE FROM connector_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO connector_oauth_states
    (state, connector_id, provider, code_verifier, user_id, callback_url, created_at, expires_at)
    VALUES (?, ?, 'asana', ?, ?, ?, ?, ?)`).run(state, input.connectorId, codeVerifier, input.userId, input.callbackUrl,
      new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  const url = new URL('https://app.asana.com/-/oauth_authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.scopes ?? PROVIDERS.asana.scopes).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { connectorId: input.connectorId, state, authorizeUrl: url.toString() };
}

export function startSlackAuthorization(
  db: Database,
  input: { connectorId: string; userId: string; callbackUrl: string; scopes?: string[] },
  config: ConnectorOAuthConfig,
): PendingConnectorAuthorization {
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(32));
  const now = Date.now();
  db.prepare('DELETE FROM connector_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO connector_oauth_states
    (state, connector_id, provider, code_verifier, user_id, callback_url, created_at, expires_at)
    VALUES (?, ?, 'slack', ?, ?, ?, ?, ?)`)
    .run(state, input.connectorId, codeVerifier, input.userId, input.callbackUrl,
      new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('scope', (input.scopes ?? PROVIDERS.slack.scopes).join(','));
  url.searchParams.set('state', state);
  return { connectorId: input.connectorId, state, authorizeUrl: url.toString() };
}

export function startGitLabAuthorization(
  db: Database,
  input: { connectorId: string; userId: string; callbackUrl: string; scopes?: string[] },
  config: ConnectorOAuthConfig,
): PendingConnectorAuthorization {
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const now = Date.now();
  db.prepare('DELETE FROM connector_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO connector_oauth_states
    (state, connector_id, provider, code_verifier, user_id, callback_url, created_at, expires_at)
    VALUES (?, ?, 'gitlab', ?, ?, ?, ?, ?)`)
    .run(state, input.connectorId, codeVerifier, input.userId, input.callbackUrl,
      new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  const url = new URL('https://gitlab.com/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.scopes ?? PROVIDERS.gitlab.scopes).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { connectorId: input.connectorId, state, authorizeUrl: url.toString() };
}

export function startNotionAuthorization(
  db: Database,
  input: { connectorId: string; userId: string; callbackUrl: string },
  config: ConnectorOAuthConfig,
): PendingConnectorAuthorization {
  const state = base64Url(randomBytes(32));
  const now = Date.now();
  db.prepare('DELETE FROM connector_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO connector_oauth_states
    (state, connector_id, provider, code_verifier, user_id, callback_url, created_at, expires_at)
    VALUES (?, ?, 'notion', '', ?, ?, ?, ?)`)
    .run(state, input.connectorId, input.userId, input.callbackUrl,
      new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  const url = new URL('https://api.notion.com/v1/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('owner', 'user');
  url.searchParams.set('state', state);
  return { connectorId: input.connectorId, state, authorizeUrl: url.toString() };
}

export function startGoogleDriveAuthorization(
  db: Database,
  input: { connectorId: string; userId: string; callbackUrl: string; scopes?: string[] },
  config: ConnectorOAuthConfig,
): PendingConnectorAuthorization {
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const now = Date.now();
  db.prepare('DELETE FROM connector_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO connector_oauth_states
    (state, connector_id, provider, code_verifier, user_id, callback_url, created_at, expires_at)
    VALUES (?, ?, 'google-drive', ?, ?, ?, ?, ?)`)
    .run(state, input.connectorId, codeVerifier, input.userId, input.callbackUrl,
      new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.scopes ?? PROVIDERS['google-drive'].scopes).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return { connectorId: input.connectorId, state, authorizeUrl: url.toString() };
}

export function startGoogleCalendarAuthorization(
  db: Database,
  input: { connectorId: string; userId: string; callbackUrl: string; scopes?: string[] },
  config: ConnectorOAuthConfig,
): PendingConnectorAuthorization {
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const now = Date.now();
  db.prepare('DELETE FROM connector_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO connector_oauth_states
    (state, connector_id, provider, code_verifier, user_id, callback_url, created_at, expires_at)
    VALUES (?, ?, 'google-calendar', ?, ?, ?, ?, ?)`).run(state, input.connectorId, codeVerifier, input.userId, input.callbackUrl,
      new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.scopes ?? PROVIDERS['google-calendar'].scopes).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return { connectorId: input.connectorId, state, authorizeUrl: url.toString() };
}

export function startGmailAuthorization(
  db: Database,
  input: { connectorId: string; userId: string; callbackUrl: string; scopes?: string[] },
  config: ConnectorOAuthConfig,
): PendingConnectorAuthorization {
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const now = Date.now();
  db.prepare('DELETE FROM connector_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO connector_oauth_states
    (state, connector_id, provider, code_verifier, user_id, callback_url, created_at, expires_at)
    VALUES (?, ?, 'gmail', ?, ?, ?, ?, ?)`).run(state, input.connectorId, codeVerifier, input.userId, input.callbackUrl,
      new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.scopes ?? PROVIDERS.gmail.scopes).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return { connectorId: input.connectorId, state, authorizeUrl: url.toString() };
}

export function startDropboxAuthorization(
  db: Database,
  input: { connectorId: string; userId: string; callbackUrl: string; scopes?: string[] },
  config: ConnectorOAuthConfig,
): PendingConnectorAuthorization {
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const now = Date.now();
  db.prepare('DELETE FROM connector_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(`INSERT INTO connector_oauth_states
    (state, connector_id, provider, code_verifier, user_id, callback_url, created_at, expires_at)
    VALUES (?, ?, 'dropbox', ?, ?, ?, ?, ?)`).run(state, input.connectorId, codeVerifier, input.userId, input.callbackUrl,
      new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString());
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.scopes ?? PROVIDERS.dropbox.scopes).join(' '));
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

export async function exchangeAsanaCode(
  input: { code: string; codeVerifier: string; redirectUri: string },
  config: ConnectorOAuthConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl('https://app.asana.com/-/oauth_token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: input.redirectUri,
        code: input.code, code_verifier: input.codeVerifier, grant_type: 'authorization_code' }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ConnectorOAuthError('Asana could not be reached', 502); }
  const body = await response.json().catch(() => ({})) as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new ConnectorOAuthError(body.error_description ?? 'Asana rejected the authorization', 502);
  return body.access_token;
}

export async function exchangeSlackCode(
  input: { code: string; redirectUri: string },
  config: ConnectorOAuthConfig,
  fetchImpl: typeof fetch,
): Promise<{ token: string; teamId: string; teamName: string; scopes: string[] }> {
  let response: Response;
  try {
    response = await fetchImpl('https://slack.com/api/oauth.v2.access', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: input.redirectUri, code: input.code }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ConnectorOAuthError('Slack could not be reached', 502); }
  const body = await response.json().catch(() => ({})) as { ok?: boolean; access_token?: string; scope?: string; team?: { id?: string; name?: string }; error?: string };
  if (!response.ok || !body.ok || !body.access_token || !body.team?.id) throw new ConnectorOAuthError(body.error ?? 'Slack rejected the authorization', 502);
  return { token: body.access_token, teamId: body.team.id, teamName: body.team.name ?? 'Slack workspace', scopes: (body.scope ?? '').split(',').filter(Boolean) };
}

export async function exchangeGitLabCode(
  input: { code: string; codeVerifier: string; redirectUri: string },
  config: ConnectorOAuthConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl('https://gitlab.com/oauth/token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: input.redirectUri,
        code: input.code, code_verifier: input.codeVerifier, grant_type: 'authorization_code' }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ConnectorOAuthError('GitLab could not be reached', 502); }
  const body = await response.json().catch(() => ({})) as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new ConnectorOAuthError(body.error_description ?? 'GitLab rejected the authorization', 502);
  return body.access_token;
}

export async function exchangeNotionCode(
  input: { code: string; redirectUri: string },
  config: ConnectorOAuthConfig,
  fetchImpl: typeof fetch,
): Promise<{ token: string; workspaceId: string; workspaceName: string; workspaceIcon?: string; botId: string }> {
  let response: Response;
  try {
    response = await fetchImpl('https://api.notion.com/v1/oauth/token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, 'notion-version': '2026-03-11' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ConnectorOAuthError('Notion could not be reached', 502); }
  const body = await response.json().catch(() => ({})) as { access_token?: string; workspace_id?: string; workspace_name?: string; workspace_icon?: string; bot_id?: string; error?: string };
  if (!response.ok || !body.access_token || !body.workspace_id || !body.bot_id) throw new ConnectorOAuthError(body.error ?? 'Notion rejected the authorization', 502);
  return { token: body.access_token, workspaceId: body.workspace_id, workspaceName: body.workspace_name ?? 'Notion workspace', workspaceIcon: body.workspace_icon, botId: body.bot_id };
}

export async function exchangeGoogleDriveCode(
  input: { code: string; codeVerifier: string; redirectUri: string },
  config: ConnectorOAuthConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: input.redirectUri,
        code: input.code, code_verifier: input.codeVerifier, grant_type: 'authorization_code' }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ConnectorOAuthError('Google could not be reached', 502); }
  const body = await response.json().catch(() => ({})) as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new ConnectorOAuthError(body.error_description ?? 'Google rejected the authorization', 502);
  return body.access_token;
}

export const exchangeGoogleCalendarCode = exchangeGoogleDriveCode;
export const exchangeGmailCode = exchangeGoogleDriveCode;

export async function exchangeDropboxCode(
  input: { code: string; codeVerifier: string; redirectUri: string },
  config: ConnectorOAuthConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: input.redirectUri,
        code: input.code, code_verifier: input.codeVerifier, grant_type: 'authorization_code' }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ConnectorOAuthError('Dropbox could not be reached', 502); }
  const body = await response.json().catch(() => ({})) as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new ConnectorOAuthError(body.error_description ?? 'Dropbox rejected the authorization', 502);
  return body.access_token;
}

export async function slackRequest(
  token: string,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const url = new URL(`/api/${method}`, 'https://slack.com');
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch { throw new ConnectorOAuthError('Slack could not be reached', 502); }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, body, headers: response.headers };
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

async function bearerJsonRequest(
  provider: string,
  token: string,
  url: string | URL,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...headers, ...(init.headers ?? {}) },
      redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch { throw new ConnectorOAuthError(`${provider} could not be reached`, 502); }
  const raw = await response.text();
  let body: Record<string, unknown>;
  try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { body = { content: raw }; }
  return { status: response.status, body, headers: response.headers };
}

export function gitlabRequest(token: string, path: string, fetchImpl: typeof fetch, init: RequestInit = {}) {
  return bearerJsonRequest('GitLab', token, new URL(path.replace(/^\//, ''), 'https://gitlab.com/api/v4/'), fetchImpl, init);
}

export function notionRequest(token: string, path: string, fetchImpl: typeof fetch, init: RequestInit = {}) {
  return bearerJsonRequest('Notion', token, new URL(path.replace(/^\//, ''), 'https://api.notion.com/v1/'), fetchImpl, init,
    { 'notion-version': '2026-03-11', 'content-type': 'application/json' });
}

export function googleRequest(token: string, url: string | URL, fetchImpl: typeof fetch, init: RequestInit = {}) {
  return bearerJsonRequest('Google', token, url, fetchImpl, init);
}

export function asanaRequest(token: string, path: string, fetchImpl: typeof fetch, init: RequestInit = {}) {
  return bearerJsonRequest('Asana', token, new URL(path.replace(/^\//, ''), 'https://app.asana.com/api/1.0/'), fetchImpl, init,
    { 'content-type': 'application/json' });
}

export function dropboxRequest(token: string, path: string, fetchImpl: typeof fetch, init: RequestInit = {}, content = false) {
  const base = content ? 'https://content.dropboxapi.com/2/' : 'https://api.dropboxapi.com/2/';
  return bearerJsonRequest('Dropbox', token, new URL(path.replace(/^\//, ''), base), fetchImpl, init,
    content ? {} : { 'content-type': 'application/json' });
}
