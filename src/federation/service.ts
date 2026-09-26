import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret, encryptDatabaseSecret } from '../db/secrets.js';
import { createMessage } from '../messages/repository.js';

export type FederationStatus = 'pending' | 'active' | 'revoked' | 'unreachable' | 'incompatible';
export interface FederationConnection {
  id: string; remoteUrl: string; remoteServerId: string | null; remoteConnectionId: string | null; remoteName: string | null;
  status: FederationStatus; scopes: string[]; createdAt: string; updatedAt: string;
  revokedAt: string | null; lastSeenAt: string | null; lastError: string | null;
}
interface ConnectionRow { id: string; remote_url: string; remote_server_id: string | null; remote_connection_id: string | null; remote_name: string | null; status: FederationStatus; scopes: string; local_secret_ciphertext: string | null; remote_secret_ciphertext: string | null; created_at: string; updated_at: string; revoked_at: string | null; last_seen_at: string | null; last_error: string | null; }

export const FEDERATION_SCOPE = /^(channel:[a-zA-Z0-9_-]+:(?:read|write)|events:receive|agent:[a-zA-Z0-9_-]+:invoke)$/;
export const MAX_FEDERATION_HOPS = 4;
const view = (row: ConnectionRow): FederationConnection => ({ id: row.id, remoteUrl: row.remote_url, remoteServerId: row.remote_server_id,
  remoteConnectionId: row.remote_connection_id, remoteName: row.remote_name, status: row.status, scopes: JSON.parse(row.scopes) as string[], createdAt: row.created_at,
  updatedAt: row.updated_at, revokedAt: row.revoked_at, lastSeenAt: row.last_seen_at, lastError: row.last_error });

export function federationSettings(db: Database): { serverId: string; enabled: boolean; displayName: string } {
  let row = db.prepare('SELECT server_id, enabled, display_name FROM federation_settings WHERE id = 1').get() as { server_id: string; enabled: number; display_name: string } | undefined;
  if (!row) {
    row = { server_id: randomUUID(), enabled: 0, display_name: 'Crewly server' };
    db.prepare('INSERT INTO federation_settings (id, server_id, enabled, display_name, updated_at) VALUES (1, ?, 0, ?, ?)')
      .run(row.server_id, row.display_name, new Date().toISOString());
  }
  return { serverId: row.server_id, enabled: Boolean(row.enabled), displayName: row.display_name };
}

export function updateFederationSettings(db: Database, input: { enabled: boolean; displayName: string }): ReturnType<typeof federationSettings> {
  federationSettings(db);
  db.prepare('UPDATE federation_settings SET enabled = ?, display_name = ?, updated_at = ? WHERE id = 1')
    .run(input.enabled ? 1 : 0, input.displayName, new Date().toISOString());
  return federationSettings(db);
}

export function listFederationConnections(db: Database): FederationConnection[] {
  return (db.prepare('SELECT * FROM federation_connections ORDER BY created_at DESC').all() as ConnectionRow[]).map(view);
}
export function getFederationConnection(db: Database, id: string): FederationConnection | undefined {
  const row = db.prepare('SELECT * FROM federation_connections WHERE id = ?').get(id) as ConnectionRow | undefined;
  return row ? view(row) : undefined;
}
function row(db: Database, id: string): ConnectionRow | undefined { return db.prepare('SELECT * FROM federation_connections WHERE id = ?').get(id) as ConnectionRow | undefined; }

export function createFederationInvitation(db: Database, input: { remoteUrl: string; scopes: string[]; createdBy: string }): { connection: FederationConnection; invitation: Record<string, unknown> } {
  const settings = federationSettings(db); if (!settings.enabled) throw new Error('federation_disabled');
  const id = randomUUID(); const secret = randomBytes(32).toString('base64url'); const now = new Date().toISOString();
  db.prepare(`INSERT INTO federation_connections (id, remote_url, status, scopes, local_secret_ciphertext, created_by, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`)
    .run(id, input.remoteUrl, JSON.stringify([...new Set(input.scopes)].sort()), encryptDatabaseSecret(db, secret), input.createdBy, now, now);
  return { connection: getFederationConnection(db, id)!, invitation: { connectionId: id, serverId: settings.serverId, serverName: settings.displayName,
    scopes: input.scopes, secret } };
}

export function receiveFederationInvitation(db: Database, input: { originUrl: string; originConnectionId: string; serverId: string; serverName: string; scopes: string[]; secret: string; createdBy: string | null }): FederationConnection {
  const settings = federationSettings(db); if (!settings.enabled) throw new Error('federation_disabled');
  const id = randomUUID(); const now = new Date().toISOString();
  db.prepare(`INSERT INTO federation_connections (id, remote_url, remote_server_id, remote_connection_id, remote_name, status, scopes, remote_secret_ciphertext, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
    .run(id, input.originUrl, input.serverId, input.originConnectionId, input.serverName, JSON.stringify([...new Set(input.scopes)].sort()), encryptDatabaseSecret(db, input.secret), input.createdBy, now, now);
  db.prepare(`INSERT INTO federation_events (id, connection_id, origin_server_id, event_type, scope, direction, payload, status, created_at)
    VALUES (?, ?, ?, 'connection.invited', 'events:receive', 'inbound', ?, 'accepted', ?)`)
    .run(randomUUID(), id, input.serverId, JSON.stringify({ originConnectionId: input.originConnectionId }), now);
  return getFederationConnection(db, id)!;
}

export function acceptFederationConnection(db: Database, id: string): { connection: FederationConnection; secret: string } {
  const current = row(db, id); if (!current?.remote_secret_ciphertext || current.status !== 'pending') throw new Error('federation_connection_not_pending');
  const now = new Date().toISOString(); db.prepare("UPDATE federation_connections SET status = 'active', updated_at = ? WHERE id = ?").run(now, id);
  return { connection: getFederationConnection(db, id)!, secret: decryptDatabaseSecret(db, current.remote_secret_ciphertext) };
}

export function confirmFederationConnection(db: Database, id: string, input: { remoteServerId: string; remoteConnectionId: string; remoteName: string }): FederationConnection {
  const current = row(db, id); if (!current?.local_secret_ciphertext || current.status !== 'pending') throw new Error('federation_connection_not_pending');
  const now = new Date().toISOString();
  db.prepare("UPDATE federation_connections SET remote_server_id = ?, remote_connection_id = ?, remote_name = ?, status = 'active', updated_at = ?, last_seen_at = ? WHERE id = ?")
    .run(input.remoteServerId, input.remoteConnectionId, input.remoteName, now, now, id);
  return getFederationConnection(db, id)!;
}

export function revokeFederationConnection(db: Database, id: string): FederationConnection | undefined {
  const now = new Date().toISOString();
  db.prepare("UPDATE federation_connections SET status = 'revoked', local_secret_ciphertext = NULL, remote_secret_ciphertext = NULL, revoked_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id); return getFederationConnection(db, id);
}

function secretFor(row: ConnectionRow): string { const ciphertext = row.local_secret_ciphertext ?? row.remote_secret_ciphertext; if (!ciphertext) throw new Error('federation_credential_missing'); return ciphertext; }
export function federationSignature(db: Database, id: string, timestamp: string, body: string): string {
  const current = row(db, id); if (!current) throw new Error('federation_connection_not_found');
  return createHmac('sha256', decryptDatabaseSecret(db, secretFor(current))).update(`${timestamp}.${body}`).digest('base64url');
}
export function verifyFederationSignature(db: Database, id: string, timestamp: string, body: string, signature: string): FederationConnection {
  const current = row(db, id); if (!current || !['pending', 'active'].includes(current.status)) throw new Error('federation_connection_inactive');
  if (Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60_000) throw new Error('federation_signature_expired');
  const expected = Buffer.from(federationSignature(db, id, timestamp, body)); const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('federation_signature_invalid');
  return view(current);
}

export function receiveFederationEvent(db: Database, connection: FederationConnection, input: { id: string; originServerId: string; causationId?: string; type: string; scope: string; hopCount: number; payload: Record<string, unknown> }): { duplicate: boolean } {
  if (input.hopCount > MAX_FEDERATION_HOPS) throw new Error('federation_hop_limit');
  if (!connection.scopes.includes(input.scope)) throw new Error('federation_scope_denied');
  if (db.prepare('SELECT 1 FROM federation_events WHERE id = ?').get(input.id)) return { duplicate: true };
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO federation_events (id, connection_id, origin_server_id, causation_id, event_type, scope, direction, hop_count, payload, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, 'accepted', ?)`)
    .run(input.id, connection.id, input.originServerId, input.causationId ?? null, input.type, input.scope, input.hopCount, JSON.stringify(input.payload), now);
  if (input.type === 'channel.message') {
    const channelId = input.scope.match(/^channel:([^:]+):write$/)?.[1];
    if (channelId) createMessage(db, { conversationId: channelId, authorId: `remote:${input.originServerId}:${String(input.payload.authorId ?? 'unknown')}`,
      authorType: 'integration', body: `[${connection.remoteName ?? input.originServerId}] ${String(input.payload.body ?? '')}`, mentions: [], replyToMessageId: null });
  }
  db.prepare('UPDATE federation_connections SET last_seen_at = ?, last_error = NULL, updated_at = ? WHERE id = ?').run(now, now, connection.id);
  return { duplicate: false };
}

export function listFederationEvents(db: Database, connectionId: string, limit = 100): Array<Record<string, unknown>> {
  return db.prepare(`SELECT id, origin_server_id AS originServerId, causation_id AS causationId, event_type AS type, scope, direction, hop_count AS hopCount,
    status, created_at AS createdAt FROM federation_events WHERE connection_id = ? ORDER BY created_at DESC LIMIT ?`).all(connectionId, limit) as Array<Record<string, unknown>>;
}
