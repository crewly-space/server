import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret, encryptDatabaseSecret } from '../db/secrets.js';

/*
 * This server's optional link to a Crewly account.
 *
 * Connecting makes the server a principal of its own in Crewly: it holds an
 * instance credential with the capabilities (scopes) its owner granted --
 * `mail:send`, `inference` and so on -- and nothing that could act as the
 * owner. Every Crewly-managed service builds on this one connection rather
 * than linking accounts its own way.
 *
 * Disconnecting forgets the credential and nothing else. Local data, local
 * providers and bring-your-own keys never depend on it.
 */

export const DEFAULT_CREWLY_CLOUD_URL = 'https://app.crewly.space';
/** Scope names come from Crewly; the server only needs them to look like one. */
export const SCOPE = /^[a-z]+(?::[a-z_]+)?$/;

export type CrewlyConnectionStatus = 'disconnected' | 'pending' | 'connected' | 'revoked';

/** What an admin sees. Never the credential or the device code. */
export interface CrewlyConnectionView {
  status: CrewlyConnectionStatus;
  cloudUrl: string | null;
  instanceId: string | null;
  scopes: string[];
  credentialVersion: number | null;
  connectedAt: string | null;
  lastCheckedAt: string | null;
  /** While pending: what the owner types or opens in Crewly. */
  link: { userCode: string; verificationUrl: string; expiresAt: string; interval: number } | null;
}

export interface CrewlyActor {
  type: 'user' | 'system';
  id: string | null;
}

interface ConnectionRow {
  cloud_url: string;
  status: 'pending' | 'connected' | 'revoked';
  device_code_ciphertext: string | null;
  user_code: string | null;
  verification_url: string | null;
  link_expires_at: string | null;
  poll_interval: number | null;
  instance_id: string | null;
  credential_ciphertext: string | null;
  credential_version: number | null;
  scopes: string;
  connected_at: string | null;
  last_checked_at: string | null;
}

/** Crewly answered, but not with what was asked for. The message is safe to show. */
export class CrewlyConnectionError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

interface CloudInstance {
  id: string;
  scopes: string[];
  credentialVersion: number;
}

const row = (db: Database): ConnectionRow | undefined =>
  db.prepare('SELECT * FROM crewly_connection WHERE id = 1').get() as ConnectionRow | undefined;

function audit(db: Database, action: string, actor: CrewlyActor, detail: Record<string, unknown> = {}): void {
  db.prepare(
    'INSERT INTO crewly_connection_audit (id, action, actor_type, actor_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(randomUUID(), action, actor.type, actor.id, JSON.stringify(detail), new Date().toISOString());
}

async function callCloud(
  fetchImpl: typeof fetch,
  cloudUrl: string,
  path: string,
  init: { method: string; body?: unknown; credential?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, cloudUrl), {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.credential ? { authorization: `Bearer ${init.credential}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CrewlyConnectionError(`Crewly at ${cloudUrl} could not be reached`);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

export function getCrewlyConnection(db: Database): CrewlyConnectionView {
  const current = row(db);
  if (!current) {
    return { status: 'disconnected', cloudUrl: null, instanceId: null, scopes: [], credentialVersion: null, connectedAt: null, lastCheckedAt: null, link: null };
  }
  return {
    status: current.status,
    cloudUrl: current.cloud_url,
    instanceId: current.instance_id,
    scopes: JSON.parse(current.scopes) as string[],
    credentialVersion: current.credential_version,
    connectedAt: current.connected_at,
    lastCheckedAt: current.last_checked_at,
    link: current.status === 'pending'
      ? { userCode: current.user_code!, verificationUrl: current.verification_url!, expiresAt: current.link_expires_at!, interval: current.poll_interval! }
      : null,
  };
}

/**
 * Asks Crewly for a link code. The admin opens the verification URL, signs in
 * to Crewly there and approves; this server never handles the owner's login.
 * Starting again replaces an unfinished link; an existing connection must be
 * disconnected first, so the server never becomes two principals by accident.
 */
export async function startCrewlyLink(
  db: Database,
  fetchImpl: typeof fetch,
  input: { cloudUrl: string; name: string; baseUrl?: string; version?: string; scopes: string[] },
  actor: CrewlyActor,
): Promise<CrewlyConnectionView> {
  const current = row(db);
  if (current && current.status === 'connected') {
    throw new CrewlyConnectionError('This server is already connected to Crewly; disconnect it first', 409);
  }
  const { status, body } = await callCloud(fetchImpl, input.cloudUrl, '/api/v1/instances/link', {
    method: 'POST',
    body: { name: input.name, baseUrl: input.baseUrl, version: input.version, scopes: input.scopes },
  });
  if (status !== 201 || typeof body.deviceCode !== 'string' || typeof body.userCode !== 'string') {
    throw new CrewlyConnectionError(typeof body.error === 'string' ? `Crewly refused the link: ${body.error}` : 'Crewly did not start a link');
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Number(body.expiresIn ?? 600) * 1000).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM crewly_connection').run();
    db.prepare(
      `INSERT INTO crewly_connection
         (id, cloud_url, status, device_code_ciphertext, user_code, verification_url, link_expires_at, poll_interval, scopes, updated_at)
       VALUES (1, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.cloudUrl,
      encryptDatabaseSecret(db, body.deviceCode as string),
      body.userCode,
      String(body.verificationUrlComplete ?? body.verificationUrl ?? input.cloudUrl),
      expiresAt,
      Number(body.interval ?? 5),
      JSON.stringify(input.scopes),
      now.toISOString(),
    );
    audit(db, 'link_started', actor, { cloudUrl: input.cloudUrl, requestedScopes: input.scopes });
  })();
  return getCrewlyConnection(db);
}

/**
 * Checks once whether the owner approved. Returns the current view either way;
 * the admin UI calls this every `interval` seconds while the link is pending.
 */
export async function pollCrewlyLink(db: Database, fetchImpl: typeof fetch, actor: CrewlyActor): Promise<CrewlyConnectionView> {
  const current = row(db);
  if (!current || current.status !== 'pending' || !current.device_code_ciphertext) {
    throw new CrewlyConnectionError('No Crewly link is waiting for approval', 409);
  }
  const deviceCode = decryptDatabaseSecret(db, current.device_code_ciphertext);
  const { status, body } = await callCloud(fetchImpl, current.cloud_url, '/api/v1/instances/link/token', {
    method: 'POST',
    body: { deviceCode },
  });
  if (status === 400 && body.error === 'authorization_pending') return getCrewlyConnection(db);
  if (status === 400 && (body.error === 'access_denied' || body.error === 'expired_token')) {
    db.transaction(() => {
      db.prepare('DELETE FROM crewly_connection').run();
      audit(db, body.error === 'access_denied' ? 'link_denied' : 'link_expired', actor);
    })();
    throw new CrewlyConnectionError(
      body.error === 'access_denied' ? 'The link was denied in Crewly' : 'The link code expired; start again',
      409,
    );
  }
  const instance = body.instance as CloudInstance | undefined;
  if (status !== 201 || typeof body.credential !== 'string' || !instance?.id) {
    throw new CrewlyConnectionError('Crewly did not issue a credential');
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE crewly_connection SET status = 'connected', device_code_ciphertext = NULL, user_code = NULL,
         verification_url = NULL, link_expires_at = NULL, poll_interval = NULL, instance_id = ?,
         credential_ciphertext = ?, credential_version = ?, scopes = ?, connected_at = ?, last_checked_at = ?, updated_at = ?
       WHERE id = 1`,
    ).run(
      instance.id,
      encryptDatabaseSecret(db, body.credential as string),
      instance.credentialVersion ?? 1,
      JSON.stringify(instance.scopes ?? []),
      now, now, now,
    );
    audit(db, 'connected', actor, { instanceId: instance.id, scopes: instance.scopes ?? [] });
  })();
  return getCrewlyConnection(db);
}

function connected(db: Database): ConnectionRow & { credential: string } {
  const current = row(db);
  if (!current || current.status !== 'connected' || !current.credential_ciphertext) {
    throw new CrewlyConnectionError('This server is not connected to Crewly', 409);
  }
  return { ...current, credential: decryptDatabaseSecret(db, current.credential_ciphertext) };
}

/** Crewly no longer honours the credential: keep the record, drop the secret. */
function markRevoked(db: Database, actor: CrewlyActor): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE crewly_connection SET status = 'revoked', credential_ciphertext = NULL, scopes = '[]', updated_at = ? WHERE id = 1",
    ).run(new Date().toISOString());
    audit(db, 'revoked_by_crewly', actor);
  })();
}

/**
 * Asks Crewly what this server may do now. Picks up scopes the owner changed
 * there, and notices a revocation, without the server reconnecting.
 */
export async function refreshCrewlyConnection(db: Database, fetchImpl: typeof fetch, actor: CrewlyActor): Promise<CrewlyConnectionView> {
  const current = connected(db);
  const { status, body } = await callCloud(fetchImpl, current.cloud_url, '/api/v1/instance', {
    method: 'GET',
    credential: current.credential,
  });
  if (status === 401) {
    markRevoked(db, actor);
    return getCrewlyConnection(db);
  }
  const instance = body.instance as CloudInstance | undefined;
  if (status !== 200 || !instance) throw new CrewlyConnectionError('Crewly did not describe this server');
  const before = JSON.parse(current.scopes) as string[];
  const after = [...instance.scopes].sort();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE crewly_connection SET scopes = ?, last_checked_at = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(after), now, now);
    if (JSON.stringify([...before].sort()) !== JSON.stringify(after)) {
      audit(db, 'scopes_changed', actor, {
        granted: after.filter((scope) => !before.includes(scope)),
        withdrawn: before.filter((scope) => !after.includes(scope)),
      });
    }
  })();
  return getCrewlyConnection(db);
}

/** Swaps the credential for a new one. Crewly keeps the same instance; the old credential stops working. */
export async function rotateCrewlyCredential(db: Database, fetchImpl: typeof fetch, actor: CrewlyActor): Promise<CrewlyConnectionView> {
  const current = connected(db);
  const { status, body } = await callCloud(fetchImpl, current.cloud_url, '/api/v1/instance/credential', {
    method: 'POST',
    credential: current.credential,
  });
  if (status === 401) {
    markRevoked(db, actor);
    throw new CrewlyConnectionError('Crewly has revoked this server; connect it again', 409);
  }
  const instance = body.instance as CloudInstance | undefined;
  if (status !== 200 || typeof body.credential !== 'string' || !instance) {
    throw new CrewlyConnectionError('Crewly did not rotate the credential');
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      'UPDATE crewly_connection SET credential_ciphertext = ?, credential_version = ?, scopes = ?, last_checked_at = ?, updated_at = ? WHERE id = 1',
    ).run(encryptDatabaseSecret(db, body.credential as string), instance.credentialVersion, JSON.stringify(instance.scopes), now, now);
    audit(db, 'credential_rotated', actor, { credentialVersion: instance.credentialVersion });
  })();
  return getCrewlyConnection(db);
}

/**
 * Forgets the connection. Crewly is told when it can be reached, so the
 * credential dies there too; when it cannot, the server still disconnects --
 * leaving should never depend on the other side answering.
 */
export async function disconnectCrewly(db: Database, fetchImpl: typeof fetch, actor: CrewlyActor): Promise<{ notifiedCrewly: boolean }> {
  const current = row(db);
  if (!current) return { notifiedCrewly: false };
  let notifiedCrewly = false;
  if (current.status === 'connected' && current.credential_ciphertext) {
    try {
      const { status } = await callCloud(fetchImpl, current.cloud_url, '/api/v1/instance', {
        method: 'DELETE',
        credential: decryptDatabaseSecret(db, current.credential_ciphertext),
      });
      notifiedCrewly = status === 204 || status === 401;
    } catch {
      notifiedCrewly = false;
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM crewly_connection').run();
    audit(db, 'disconnected', actor, { instanceId: current.instance_id, notifiedCrewly });
  })();
  return { notifiedCrewly };
}

/**
 * What a Crewly-managed service needs to call Crewly for this server: the
 * address and the instance credential, if the connection is live and holds
 * `scope`. Undefined otherwise, so the caller can fall back to local/BYO.
 * Server-side only; never hand the result to a browser.
 */
export function crewlyServiceCredential(db: Database, scope: string): { cloudUrl: string; instanceId: string; credential: string } | undefined {
  const current = row(db);
  if (!current || current.status !== 'connected' || !current.credential_ciphertext || !current.instance_id) return undefined;
  if (!(JSON.parse(current.scopes) as string[]).includes(scope)) return undefined;
  return { cloudUrl: current.cloud_url, instanceId: current.instance_id, credential: decryptDatabaseSecret(db, current.credential_ciphertext) };
}

/**
 * One call to a Crewly-managed service as this server, holding `scope`.
 * Throws CrewlyConnectionError (409) when the connection or scope is missing,
 * and (502) when Crewly cannot be reached; otherwise returns Crewly's answer.
 */
export async function crewlyServiceRequest(
  db: Database,
  fetchImpl: typeof fetch,
  scope: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const connection = crewlyServiceCredential(db, scope);
  if (!connection) throw new CrewlyConnectionError(`Connect this server to Crewly with ${scope} first`, 409);
  return callCloud(fetchImpl, connection.cloudUrl, path, { method, body, credential: connection.credential });
}

export interface CrewlyAuditEntry {
  id: string;
  action: string;
  actor: CrewlyActor;
  detail: Record<string, unknown>;
  at: string;
}

export function listCrewlyAudit(db: Database, limit: number): CrewlyAuditEntry[] {
  const rows = db.prepare('SELECT * FROM crewly_connection_audit ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Array<{
    id: string; action: string; actor_type: CrewlyActor['type']; actor_id: string | null; detail: string; created_at: string;
  }>;
  return rows.map((entry) => ({
    id: entry.id,
    action: entry.action,
    actor: { type: entry.actor_type, id: entry.actor_id },
    detail: JSON.parse(entry.detail),
    at: entry.created_at,
  }));
}
