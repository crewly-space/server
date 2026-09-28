import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret, encryptDatabaseSecret } from '../db/secrets.js';
import { asanaRequest, dropboxRequest, githubRequest, gitlabRequest, googleRequest, linearRequest, notionRequest, slackRequest, PROVIDERS, type ConnectorCapability, type ConnectorProvider, type ConnectorStatus } from './providers.js';

export type ConnectorActor = { type: 'user' | 'agent' | 'automation' | 'integration' | 'system'; id: string | null };
export type ConnectorGranteeType = 'agent' | 'automation' | 'integration';

interface ConnectorRow {
  id: string; provider: ConnectorProvider; account_id: string | null; account_name: string | null; account_url: string | null;
  scopes: string; status: ConnectorStatus; owner_user_id: string; token_type: string | null; credential_ciphertext: string | null;
  metadata: string; created_at: string; updated_at: string; last_used_at: string | null; last_checked_at: string | null;
  revoked_at: string | null; last_error: string | null;
}

export interface ConnectorView {
  id: string; provider: ConnectorProvider; accountId: string | null; accountName: string | null; accountUrl: string | null;
  scopes: string[]; status: ConnectorStatus; ownerUserId: string; createdAt: string; updatedAt: string;
  lastUsedAt: string | null; lastCheckedAt: string | null; revokedAt: string | null; lastError: string | null;
  capabilities: ConnectorCapability[];
}
export interface ConnectorGrant { connectorId: string; granteeType: ConnectorGranteeType; granteeId: string; capability: ConnectorCapability; createdAt: string; }

function audit(db: Database, connector: Pick<ConnectorRow, 'id' | 'provider'> | null, action: string, actor: ConnectorActor, detail: Record<string, unknown> = {}): void {
  db.prepare(`INSERT INTO connector_audit (id, connector_id, provider, action, actor_type, actor_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), connector?.id ?? null, connector?.provider ?? 'unknown', action, actor.type, actor.id, JSON.stringify(detail), new Date().toISOString());
}

function view(row: ConnectorRow): ConnectorView {
  return { id: row.id, provider: row.provider, accountId: row.account_id, accountName: row.account_name, accountUrl: row.account_url,
    scopes: JSON.parse(row.scopes) as string[], status: row.status, ownerUserId: row.owner_user_id, createdAt: row.created_at,
    updatedAt: row.updated_at, lastUsedAt: row.last_used_at, lastCheckedAt: row.last_checked_at, revokedAt: row.revoked_at,
    lastError: row.last_error, capabilities: PROVIDERS[row.provider]?.capabilities ?? [] };
}

export function getConnector(db: Database, id: string): ConnectorView | undefined {
  const row = db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as ConnectorRow | undefined;
  return row ? view(row) : undefined;
}
export function listConnectors(db: Database): ConnectorView[] {
  return (db.prepare('SELECT * FROM connectors ORDER BY created_at DESC').all() as ConnectorRow[]).map(view);
}
export function getConnectorRow(db: Database, id: string): ConnectorRow | undefined {
  return db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as ConnectorRow | undefined;
}
export function createPendingConnector(db: Database, input: { id: string; provider: ConnectorProvider; ownerUserId: string }, actor: ConnectorActor): ConnectorView {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO connectors (id, provider, status, owner_user_id, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?, ?)`).run(input.id, input.provider, input.ownerUserId, now, now);
  audit(db, { id: input.id, provider: input.provider }, 'connection_started', actor);
  return getConnector(db, input.id)!;
}
/**
 * Reuse an existing connector for a new sign-in, so reconnecting keeps its
 * agent grants and history instead of leaving a revoked duplicate behind.
 * Its status is untouched until the sign-in completes.
 */
export function restartConnector(db: Database, input: { id: string; provider: ConnectorProvider }, actor: ConnectorActor): ConnectorView {
  const current = getConnectorRow(db, input.id);
  if (!current) throw new Error('connector_not_found');
  if (current.provider !== input.provider) throw new Error('connector_provider_mismatch');
  audit(db, current, 'reconnection_started', actor);
  return view(current);
}
export function connectConnector(db: Database, id: string, input: { token: string; accountId: string; accountName: string; accountUrl?: string; scopes: string[]; metadata?: Record<string, unknown> }, actor: ConnectorActor): ConnectorView {
  const current = getConnectorRow(db, id);
  if (!current) throw new Error('connector_not_found');
  const now = new Date().toISOString();
  db.prepare(`UPDATE connectors SET account_id = ?, account_name = ?, account_url = ?, scopes = ?, status = 'connected',
    token_type = 'bearer', credential_ciphertext = ?, metadata = ?, updated_at = ?, last_checked_at = ?, revoked_at = NULL, last_error = NULL
    WHERE id = ?`).run(input.accountId, input.accountName, input.accountUrl ?? null, JSON.stringify([...new Set(input.scopes)].sort()),
    encryptDatabaseSecret(db, input.token), JSON.stringify(input.metadata ?? {}), now, now, id);
  audit(db, current, 'connected', actor, { accountId: input.accountId, scopes: input.scopes });
  return getConnector(db, id)!;
}
export function setConnectorStatus(db: Database, id: string, status: ConnectorStatus, actor: ConnectorActor, error?: string): ConnectorView {
  const current = getConnectorRow(db, id); if (!current) throw new Error('connector_not_found');
  const now = new Date().toISOString();
  db.prepare('UPDATE connectors SET status = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?').run(status, error ?? null, now, now, id);
  audit(db, current, status === 'connected' ? 'refreshed' : 'health_changed', actor, { status, error: error ?? null });
  return getConnector(db, id)!;
}
export function revokeConnector(db: Database, id: string, actor: ConnectorActor): ConnectorView | undefined {
  const current = getConnectorRow(db, id); if (!current) return undefined;
  const now = new Date().toISOString();
  db.prepare(`UPDATE connectors SET status = 'revoked', credential_ciphertext = NULL, scopes = '[]', revoked_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`).run(now, now, id);
  audit(db, current, 'revoked', actor);
  return getConnector(db, id);
}
export function refreshConnector(db: Database, id: string, actor: ConnectorActor, fetchImpl: typeof fetch): Promise<ConnectorView> {
  const current = getConnectorRow(db, id); if (!current || !current.credential_ciphertext) throw new Error('connector_not_connected');
  const token = decryptDatabaseSecret(db, current.credential_ciphertext);
  return (async () => {
    const result = current.provider === 'github' ? await githubRequest(token, '/user', fetchImpl)
      : current.provider === 'gitlab' ? await gitlabRequest(token, 'user', fetchImpl)
        : current.provider === 'linear' ? await linearRequest(token, 'query Viewer { viewer { id name email url } }', {}, fetchImpl)
          : current.provider === 'asana' ? await asanaRequest(token, 'users/me', fetchImpl)
            : current.provider === 'notion' ? await notionRequest(token, 'users/me', fetchImpl)
              : current.provider === 'google-drive' || current.provider === 'google-calendar' || current.provider === 'gmail'
                ? await googleRequest(token, 'https://www.googleapis.com/oauth2/v3/userinfo', fetchImpl)
                : current.provider === 'dropbox' ? await dropboxRequest(token, 'users/get_current_account', fetchImpl, { method: 'POST', body: '{}' })
                  : await slackRequest(token, 'auth.test', {}, fetchImpl);
    const label = PROVIDERS[current.provider].label;
    // Slack answers 200 with ok:false, so a dead token only shows in the body.
    const slackError = current.provider === 'slack' && result.body.ok !== true ? String(result.body.error ?? '') : '';
    if (result.status === 401 || ['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed'].includes(slackError)) {
      return setConnectorStatus(db, id, 'permission_revoked', actor, `${label} no longer accepts this connection. Reconnect to sign in again.`);
    }
    if (result.status === 429 || (result.status === 403 && result.headers.get('x-ratelimit-remaining') === '0') || slackError === 'ratelimited') {
      return setConnectorStatus(db, id, 'rate_limited', actor, `${label} rate limit reached. Try again later.`);
    }
    if (result.status >= 500) return setConnectorStatus(db, id, 'provider_unavailable', actor, `${label} is unavailable right now.`);
    const profile = current.provider === 'linear' ? (result.body.data as { viewer?: Record<string, unknown> } | undefined)?.viewer
      : current.provider === 'asana' ? (() => { const user = result.body.data as Record<string, unknown> | undefined; return user ? { ...user, id: user.gid } : undefined; })()
      : current.provider === 'slack' ? { id: result.body.team_id, name: result.body.team, url: result.body.url }
        : current.provider === 'notion' ? { id: result.body.bot_id ?? result.body.id, name: current.account_name, url: current.account_url }
          : current.provider === 'google-drive' || current.provider === 'google-calendar' || current.provider === 'gmail'
            ? { id: result.body.sub, name: result.body.name ?? result.body.email, url: current.account_url }
            : current.provider === 'dropbox'
              ? { id: result.body.account_id, name: (result.body.name as Record<string, unknown> | undefined)?.display_name ?? result.body.email, url: current.account_url }
              : result.body;
    const normalized = profile as Record<string, unknown> | undefined;
    if (result.status !== 200 || (current.provider === 'slack' && result.body.ok !== true) || !normalized?.id) return setConnectorStatus(db, id, 'action_required', actor, `${label} returned an unexpected account. Reconnect to sign in again.`);
    const now = new Date().toISOString();
    db.prepare(`UPDATE connectors SET account_id = ?, account_name = ?, account_url = ?, status = 'connected', last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(String(normalized.id), String(normalized.login ?? normalized.username ?? normalized.name ?? ''), typeof (normalized.html_url ?? normalized.web_url ?? normalized.url) === 'string' ? (normalized.html_url ?? normalized.web_url ?? normalized.url) : current.account_url, now, now, id);
    audit(db, current, 'refreshed', actor, { accountId: String(normalized.id) });
    return getConnector(db, id)!;
  })();
}

export function listConnectorGrants(db: Database, connectorId: string): ConnectorGrant[] {
  return (db.prepare('SELECT connector_id AS connectorId, grantee_type AS granteeType, grantee_id AS granteeId, capability, created_at AS createdAt FROM connector_grants WHERE connector_id = ? ORDER BY grantee_type, grantee_id, capability').all(connectorId) as ConnectorGrant[]);
}
export function hasConnectorGrant(db: Database, input: { connectorId: string; granteeType: ConnectorGranteeType; granteeId: string; capability: ConnectorCapability }): boolean {
  return db.prepare('SELECT 1 FROM connector_grants WHERE connector_id = ? AND grantee_type = ? AND grantee_id = ? AND capability = ?')
    .get(input.connectorId, input.granteeType, input.granteeId, input.capability) !== undefined;
}
export function setConnectorGrants(db: Database, connectorId: string, grants: Array<{ granteeType: ConnectorGranteeType; granteeId: string; capability: ConnectorCapability }>, actor: ConnectorActor): ConnectorGrant[] {
  const current = getConnectorRow(db, connectorId); if (!current) throw new Error('connector_not_found');
  const known = new Set(PROVIDERS[current.provider]?.capabilities ?? []);
  if (grants.some((grant) => !known.has(grant.capability))) throw new Error('unknown_connector_capability');
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM connector_grants WHERE connector_id = ?').run(connectorId);
    const insert = db.prepare('INSERT INTO connector_grants (connector_id, grantee_type, grantee_id, capability, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const grant of grants) insert.run(connectorId, grant.granteeType, grant.granteeId, grant.capability, now);
    audit(db, current, 'grants_changed', actor, { count: grants.length });
  })();
  return listConnectorGrants(db, connectorId);
}

/** Server-side integrations use this gate before a connector call. */
export function connectorCredential(db: Database, input: { connectorId: string; granteeType: ConnectorGranteeType; granteeId: string; capability: ConnectorCapability }, actor: ConnectorActor): { provider: ConnectorProvider; token: string } {
  const current = getConnectorRow(db, input.connectorId);
  if (!current || !current.credential_ciphertext) throw new Error('connector_not_connected');
  if (current.status !== 'connected') throw new Error(`connector_${current.status}`);
  const grant = db.prepare('SELECT 1 FROM connector_grants WHERE connector_id = ? AND grantee_type = ? AND grantee_id = ? AND capability = ?')
    .get(input.connectorId, input.granteeType, input.granteeId, input.capability);
  if (!grant) throw new Error('connector_capability_not_granted');
  const now = new Date().toISOString();
  db.prepare('UPDATE connectors SET last_used_at = ?, updated_at = ? WHERE id = ?').run(now, now, input.connectorId);
  audit(db, current, 'call_authorized', actor, { capability: input.capability });
  return { provider: current.provider, token: decryptDatabaseSecret(db, current.credential_ciphertext) };
}

/** Used only by an authenticated admin import route; never serialized. */
export function connectorTokenForImport(db: Database, connectorId: string): { provider: ConnectorProvider; token: string } {
  const current = getConnectorRow(db, connectorId);
  if (!current || current.status !== 'connected' || !current.credential_ciphertext) throw new Error('connector_not_connected');
  return { provider: current.provider, token: decryptDatabaseSecret(db, current.credential_ciphertext) };
}

export function listConnectorAudit(db: Database, connectorId: string, limit: number): Array<Record<string, unknown>> {
  return db.prepare('SELECT id, connector_id AS connectorId, provider, action, actor_type AS actorType, actor_id AS actorId, detail, created_at AS at FROM connector_audit WHERE connector_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(connectorId, limit) as Array<Record<string, unknown>>;
}

export async function connectorCall(
  db: Database,
  input: { connectorId: string; agentId: string; capability: ConnectorCapability; operation: 'read' | 'write'; payload: Record<string, unknown> },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const credential = connectorCredential(db, { connectorId: input.connectorId, granteeType: 'agent', granteeId: input.agentId, capability: input.capability }, { type: 'agent', id: input.agentId });
  const current = getConnectorRow(db, input.connectorId);
  if (!current) throw new Error('connector_not_found');
  let result: { status: number; body: Record<string, unknown> };
  if (credential.provider === 'github') {
    const repo = String(input.payload.repo ?? '');
    const path = input.capability === 'read_profile' ? '/user'
      : input.capability === 'read_repository' ? `/repos/${repo}`
      : input.capability === 'read_issues' ? `/repos/${repo}/issues`
      : input.capability === 'create_issue' ? `/repos/${repo}/issues`
      : `/repos/${repo}/issues/${String(input.payload.issueNumber ?? '')}/comments`;
    const init: RequestInit = input.operation === 'write' ? { method: 'POST', body: JSON.stringify({ title: input.payload.title, body: input.payload.body }) } : {};
    const response = await githubRequest(credential.token, path, fetchImpl, init);
    result = { status: response.status, body: response.body };
  } else if (credential.provider === 'gitlab') {
    const project = encodeURIComponent(String(input.payload.project ?? input.payload.repo ?? ''));
    const item = encodeURIComponent(String(input.payload.issueNumber ?? input.payload.issueId ?? ''));
    const path = input.capability === 'read_profile' ? 'user'
      : input.capability === 'read_repository' ? `projects/${project}`
        : input.capability === 'read_issues' || input.capability === 'create_issue' ? `projects/${project}/issues`
          : input.capability === 'comment_on_pull_request' ? `projects/${project}/merge_requests/${item}/notes`
            : `projects/${project}/issues/${item}/notes`;
    const body = input.capability === 'create_issue'
      ? { title: input.payload.title, description: input.payload.body }
      : { body: input.payload.body };
    const response = await gitlabRequest(credential.token, path, fetchImpl,
      input.operation === 'write' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    result = { status: response.status, body: response.body };
  } else if (credential.provider === 'linear') {
    const query = input.capability === 'read_issues'
      ? 'query Issues($first:Int){ issues(first:$first){ nodes { id identifier title url state { name } } } }'
      : input.capability === 'read_projects'
        ? 'query Projects($first:Int){ projects(first:$first){ nodes { id name url state } } }'
        : input.capability === 'create_issue'
          ? 'mutation CreateIssue($input:IssueCreateInput!){ issueCreate(input:$input){ success issue { id identifier title url } } }'
          : 'mutation CommentIssue($input:CommentCreateInput!){ commentCreate(input:$input){ success comment { id body } } }';
    const variables = input.capability === 'create_issue'
      ? { input: { teamId: String(input.payload.teamId ?? ''), title: String(input.payload.title ?? ''), description: input.payload.body ? String(input.payload.body) : undefined } }
      : input.capability === 'comment_on_issue'
        ? { input: { issueId: String(input.payload.issueId ?? ''), body: String(input.payload.body ?? '') } }
        : { first: Math.min(50, Math.max(1, Number(input.payload.first ?? 20))) };
    const response = await linearRequest(credential.token, query, variables, fetchImpl);
    result = { status: response.status, body: response.body };
  } else if (credential.provider === 'asana') {
    const workspaceId = encodeURIComponent(String(input.payload.workspaceId ?? ''));
    const projectId = encodeURIComponent(String(input.payload.projectId ?? ''));
    const taskId = encodeURIComponent(String(input.payload.taskId ?? input.payload.issueId ?? ''));
    const path = input.capability === 'read_profile' ? 'users/me'
      : input.capability === 'read_projects' ? `workspaces/${workspaceId}/projects?limit=${Math.min(100, Math.max(1, Number(input.payload.first ?? 20)))}`
        : input.capability === 'read_issues' ? `projects/${projectId}/tasks?limit=${Math.min(100, Math.max(1, Number(input.payload.first ?? 20)))}&opt_fields=name,completed,permalink_url,due_on`
          : input.capability === 'create_issue' ? 'tasks' : `tasks/${taskId}/stories`;
    const body = input.capability === 'create_issue'
      ? { data: { name: String(input.payload.title ?? ''), notes: String(input.payload.body ?? ''), projects: [String(input.payload.projectId ?? '')],
        ...(input.payload.dueOn ? { due_on: String(input.payload.dueOn) } : {}), ...(input.payload.assignee ? { assignee: String(input.payload.assignee) } : {}) } }
      : { data: { text: String(input.payload.body ?? input.payload.content ?? '') } };
    const response = await asanaRequest(credential.token, path, fetchImpl,
      input.operation === 'write' ? { method: 'POST', body: JSON.stringify(body) } : {});
    result = { status: response.status, body: response.body };
  } else if (credential.provider === 'notion') {
    const pageId = encodeURIComponent(String(input.payload.pageId ?? ''));
    const text = String(input.payload.content ?? input.payload.body ?? '');
    const path = input.capability === 'read_profile' ? 'users/me'
      : input.capability === 'search_pages' ? 'search'
        : input.capability === 'read_pages' ? `pages/${pageId}`
          : input.capability === 'create_page' ? 'pages' : 'comments';
    const body = input.capability === 'search_pages'
      ? { query: String(input.payload.query ?? ''), page_size: Math.min(100, Math.max(1, Number(input.payload.first ?? 20))), filter: { property: 'object', value: 'page' } }
      : input.capability === 'create_page'
        ? { parent: { page_id: String(input.payload.parentPageId ?? input.payload.pageId ?? '') },
          properties: { title: { type: 'title', title: [{ type: 'text', text: { content: String(input.payload.title ?? 'Untitled') } }] } },
          ...(text ? { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } }] } : {}) }
        : { parent: { page_id: String(input.payload.pageId ?? '') }, rich_text: [{ type: 'text', text: { content: text } }] };
    const response = await notionRequest(credential.token, path, fetchImpl,
      ['search_pages', 'create_page', 'comment_on_page'].includes(input.capability)
        ? { method: 'POST', body: JSON.stringify(body) } : {});
    result = { status: response.status, body: response.body };
  } else if (credential.provider === 'google-drive') {
    const fileId = encodeURIComponent(String(input.payload.fileId ?? ''));
    if (input.capability === 'read_profile') {
      const response = await googleRequest(credential.token, 'https://www.googleapis.com/oauth2/v3/userinfo', fetchImpl);
      result = { status: response.status, body: response.body };
    } else if (input.capability === 'search_files') {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      const query = String(input.payload.query ?? '').replaceAll("'", "\\'");
      if (query) url.searchParams.set('q', `name contains '${query}' and trashed = false`);
      url.searchParams.set('pageSize', String(Math.min(100, Math.max(1, Number(input.payload.first ?? 20)))));
      url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,webViewLink,size),nextPageToken');
      const response = await googleRequest(credential.token, url, fetchImpl);
      result = { status: response.status, body: response.body };
    } else if (input.capability === 'read_files') {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
      url.searchParams.set('alt', 'media');
      const response = await googleRequest(credential.token, url, fetchImpl);
      result = { status: response.status, body: response.body };
    } else {
      const boundary = `crewly_${randomUUID().replaceAll('-', '')}`;
      const metadata = JSON.stringify({ name: String(input.payload.filename ?? input.payload.title ?? 'Crewly file'),
        mimeType: String(input.payload.mimeType ?? 'text/plain') });
      const content = String(input.payload.content ?? input.payload.body ?? '');
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${String(input.payload.mimeType ?? 'text/plain')}\r\n\r\n${content}\r\n--${boundary}--`;
      const response = await googleRequest(credential.token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink', fetchImpl,
        { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: multipart });
      result = { status: response.status, body: response.body };
    }
  } else if (credential.provider === 'google-calendar') {
    const calendarId = encodeURIComponent(String(input.payload.calendarId ?? 'primary'));
    const eventId = encodeURIComponent(String(input.payload.eventId ?? ''));
    if (input.capability === 'read_profile') {
      const response = await googleRequest(credential.token, 'https://www.googleapis.com/oauth2/v3/userinfo', fetchImpl);
      result = { status: response.status, body: response.body };
    } else if (input.capability === 'read_calendar') {
      const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
      url.searchParams.set('maxResults', String(Math.min(100, Math.max(1, Number(input.payload.first ?? 20)))));
      const response = await googleRequest(credential.token, url, fetchImpl);
      result = { status: response.status, body: response.body };
    } else if (input.capability === 'read_events') {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`);
      url.searchParams.set('maxResults', String(Math.min(100, Math.max(1, Number(input.payload.first ?? 20)))));
      url.searchParams.set('singleEvents', 'true'); url.searchParams.set('orderBy', 'startTime');
      if (input.payload.timeMin) url.searchParams.set('timeMin', String(input.payload.timeMin));
      if (input.payload.timeMax) url.searchParams.set('timeMax', String(input.payload.timeMax));
      if (input.payload.query) url.searchParams.set('q', String(input.payload.query));
      const response = await googleRequest(credential.token, url, fetchImpl);
      result = { status: response.status, body: response.body };
    } else {
      const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events${eventId ? `/${eventId}` : ''}`;
      const event = { summary: String(input.payload.title ?? ''), description: String(input.payload.body ?? ''),
        start: { dateTime: String(input.payload.start ?? ''), ...(input.payload.timeZone ? { timeZone: String(input.payload.timeZone) } : {}) },
        end: { dateTime: String(input.payload.end ?? ''), ...(input.payload.timeZone ? { timeZone: String(input.payload.timeZone) } : {}) } };
      const init: RequestInit = input.capability === 'delete_event' ? { method: 'DELETE' }
        : { method: input.capability === 'update_event' ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) };
      const response = await googleRequest(credential.token, url, fetchImpl, init);
      result = { status: response.status, body: response.body };
    }
  } else if (credential.provider === 'gmail') {
    if (input.capability === 'read_profile') {
      const response = await googleRequest(credential.token, 'https://www.googleapis.com/oauth2/v3/userinfo', fetchImpl);
      result = { status: response.status, body: response.body };
    } else if (input.capability === 'search_email') {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      const query = String(input.payload.query ?? '');
      if (query) url.searchParams.set('q', query);
      url.searchParams.set('maxResults', String(Math.min(100, Math.max(1, Number(input.payload.first ?? 20)))));
      const response = await googleRequest(credential.token, url, fetchImpl);
      result = { status: response.status, body: response.body };
    } else if (input.capability === 'read_email') {
      const messageId = encodeURIComponent(String(input.payload.messageId ?? ''));
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`);
      url.searchParams.set('format', String(input.payload.format ?? 'full'));
      const response = await googleRequest(credential.token, url, fetchImpl);
      result = { status: response.status, body: response.body };
    } else {
      const cleanHeader = (value: unknown) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
      const to = cleanHeader(input.payload.to);
      const subject = cleanHeader(input.payload.subject ?? input.payload.title);
      const cc = cleanHeader(input.payload.cc);
      const bcc = cleanHeader(input.payload.bcc);
      const body = String(input.payload.body ?? input.payload.content ?? '');
      const mime = [`To: ${to}`, ...(cc ? [`Cc: ${cc}`] : []), ...(bcc ? [`Bcc: ${bcc}`] : []),
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, 'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body].join('\r\n');
      const raw = Buffer.from(mime).toString('base64url');
      const response = await googleRequest(credential.token, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', fetchImpl,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }) });
      result = { status: response.status, body: response.body };
    }
  } else if (credential.provider === 'dropbox') {
    const path = String(input.payload.path ?? input.payload.fileId ?? '');
    if (input.capability === 'read_profile') {
      const response = await dropboxRequest(credential.token, 'users/get_current_account', fetchImpl, { method: 'POST', body: '{}' });
      result = { status: response.status, body: response.body };
    } else if (input.capability === 'search_files') {
      const response = await dropboxRequest(credential.token, 'files/search_v2', fetchImpl, { method: 'POST', body: JSON.stringify({
        query: String(input.payload.query ?? ''), options: { max_results: Math.min(100, Math.max(1, Number(input.payload.first ?? 20))), file_status: 'active' },
      }) });
      result = { status: response.status, body: response.body };
    } else if (input.capability === 'read_files') {
      const response = await dropboxRequest(credential.token, 'files/download', fetchImpl,
        { method: 'POST', headers: { 'Dropbox-API-Arg': JSON.stringify({ path }) } }, true);
      result = { status: response.status, body: response.body };
    } else {
      const response = await dropboxRequest(credential.token, 'files/upload', fetchImpl, { method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: path || `/${String(input.payload.filename ?? input.payload.title ?? 'crewly.txt')}`, mode: 'add', autorename: true }) },
        body: String(input.payload.content ?? input.payload.body ?? '') }, true);
      result = { status: response.status, body: response.body };
    }
  } else {
    const method = input.capability === 'read_channels' ? 'conversations.list'
      : input.capability === 'read_messages' ? 'conversations.history'
      : input.capability === 'post_messages' ? 'chat.postMessage' : 'auth.test';
    const response = await slackRequest(credential.token, method, input.payload as Record<string, string | number | boolean | undefined>, fetchImpl);
    result = { status: response.status, body: response.body };
  }
  if (result.status >= 400) {
    setConnectorStatus(db, input.connectorId, result.status === 401 ? 'permission_revoked' : result.status === 429 ? 'rate_limited' : 'action_required', { type: 'agent', id: input.agentId }, `Connector request returned ${result.status}`);
    throw new Error(`connector_request_failed_${result.status}`);
  }
  db.prepare(`INSERT INTO connector_audit (id, connector_id, provider, action, actor_type, actor_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), current.id, current.provider, `${input.operation}_${input.capability}`, 'agent', input.agentId, JSON.stringify({ status: result.status }), new Date().toISOString());
  return result.body;
}
