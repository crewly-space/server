import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret, encryptDatabaseSecret } from '../db/secrets.js';
import { githubRequest, PROVIDERS, type ConnectorCapability, type ConnectorProvider, type ConnectorStatus } from './providers.js';

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
    const result = await githubRequest(token, '/user', fetchImpl);
    if (result.status === 401) return setConnectorStatus(db, id, 'permission_revoked', actor, 'GitHub rejected the connector credential');
    if (result.status === 403 && result.headers.get('x-ratelimit-remaining') === '0') return setConnectorStatus(db, id, 'rate_limited', actor, 'GitHub rate limit reached');
    if (result.status >= 500) return setConnectorStatus(db, id, 'provider_unavailable', actor, 'GitHub is unavailable');
    if (result.status !== 200 || typeof result.body.id !== 'number') return setConnectorStatus(db, id, 'action_required', actor, 'GitHub returned an unexpected account response');
    const now = new Date().toISOString();
    db.prepare(`UPDATE connectors SET account_id = ?, account_name = ?, account_url = ?, status = 'connected', last_checked_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(String(result.body.id), String(result.body.login ?? ''), typeof result.body.html_url === 'string' ? result.body.html_url : current.account_url, now, now, id);
    audit(db, current, 'refreshed', actor, { accountId: String(result.body.id) });
    return getConnector(db, id)!;
  })();
}

export function listConnectorGrants(db: Database, connectorId: string): ConnectorGrant[] {
  return (db.prepare('SELECT connector_id AS connectorId, grantee_type AS granteeType, grantee_id AS granteeId, capability, created_at AS createdAt FROM connector_grants WHERE connector_id = ? ORDER BY grantee_type, grantee_id, capability').all(connectorId) as ConnectorGrant[]);
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

export function listConnectorAudit(db: Database, connectorId: string, limit: number): Array<Record<string, unknown>> {
  return db.prepare('SELECT id, connector_id AS connectorId, provider, action, actor_type AS actorType, actor_id AS actorId, detail, created_at AS at FROM connector_audit WHERE connector_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(connectorId, limit) as Array<Record<string, unknown>>;
}
