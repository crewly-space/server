import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret, encryptDatabaseSecret } from '../db/secrets.js';

export type GranteeType = 'agent' | 'runtime' | 'mcp_server' | 'automation' | 'integration' | 'skill';
export const GRANTEE_TYPES: readonly GranteeType[] = ['agent', 'runtime', 'mcp_server', 'automation', 'integration', 'skill'];

export interface Grantee {
  type: GranteeType;
  id: string;
}

/** Who did something to or with a secret, for the audit log. */
export interface SecretActor {
  type: 'user' | 'system' | GranteeType;
  id: string | null;
}

export interface SecretMetadata {
  id: string;
  name: string;
  description: string;
  version: number;
  revoked: boolean;
  grants: Grantee[];
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
}

/** Something that would break if a secret went away. */
export interface SecretDependent {
  type: string;
  id: string;
  name: string;
  /** How it depends: `grant` (it was given the secret) or `reference` (its config names it). */
  via: 'grant' | 'reference';
}

export class SecretNotFoundError extends Error {}
export class SecretNameTakenError extends Error {}
export class SecretInUseError extends Error {
  constructor(readonly dependents: SecretDependent[]) {
    super(`the secret is used by ${dependents.length} configuration(s)`);
  }
}
/** Asked for a secret it was not granted, or one that was revoked. The message names which. */
export class SecretAccessError extends Error {
  readonly code = 'secret_unavailable';
}

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** How configuration refers to a secret without containing it. */
const REFERENCE = /\{\{\s*secret:([A-Z][A-Z0-9_]{0,63})\s*\}\}/g;

interface SecretRow {
  id: string;
  name: string;
  description: string;
  ciphertext: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
}

/**
 * Finds configurations that mention a secret by name. Features that store
 * references (MCP servers, skills) register one, so deleting or renaming a
 * secret can say what it would break before it breaks it.
 */
export type SecretReferenceScanner = (db: Database, secretName: string) => SecretDependent[];
const scanners: SecretReferenceScanner[] = [];

export function registerSecretReferenceScanner(scanner: SecretReferenceScanner): void {
  if (!scanners.includes(scanner)) scanners.push(scanner);
}

/** Turns a grantee id into something a person recognises, per grantee type. */
const granteeNames = new Map<string, (db: Database, id: string) => string | undefined>([
  ['agent', (db, id) => (db.prepare('SELECT name FROM agents WHERE id = ?').pluck().get(id) as string | undefined)],
]);

export function registerGranteeNamer(type: GranteeType, namer: (db: Database, id: string) => string | undefined): void {
  granteeNames.set(type, namer);
}

export function findSecretReferences(text: string): string[] {
  return [...new Set([...text.matchAll(REFERENCE)].map((match) => match[1]!))];
}

function audit(db: Database, row: Pick<SecretRow, 'id' | 'name'>, action: string, actor: SecretActor, detail: Record<string, unknown> = {}): void {
  db.prepare(
    `INSERT INTO secret_audit (id, secret_id, secret_name, action, actor_type, actor_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), row.id, row.name, action, actor.type, actor.id, JSON.stringify(detail), new Date().toISOString());
}

function grantsOf(db: Database, secretId: string): Grantee[] {
  return (db
    .prepare('SELECT grantee_type AS type, grantee_id AS id FROM secret_grants WHERE secret_id = ? ORDER BY grantee_type, grantee_id')
    .all(secretId) as Grantee[]);
}

function metadata(db: Database, row: SecretRow): SecretMetadata {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    revoked: row.revoked_at !== null,
    grants: grantsOf(db, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

function rowById(db: Database, id: string): SecretRow {
  const row = db.prepare('SELECT * FROM secrets WHERE id = ?').get(id) as SecretRow | undefined;
  if (!row) throw new SecretNotFoundError(id);
  return row;
}

export function getSecret(db: Database, id: string): SecretMetadata | undefined {
  const row = db.prepare('SELECT * FROM secrets WHERE id = ?').get(id) as SecretRow | undefined;
  return row ? metadata(db, row) : undefined;
}

export function listSecrets(db: Database): SecretMetadata[] {
  return (db.prepare('SELECT * FROM secrets ORDER BY name').all() as SecretRow[]).map((row) => metadata(db, row));
}

/** Stores a secret. The value goes in and does not come back out through this module's API. */
export function createSecret(
  db: Database,
  input: { name: string; value: string; description?: string },
  actor: SecretActor,
): SecretMetadata {
  if (!SECRET_NAME.test(input.name)) throw new Error('secret names are UPPER_SNAKE_CASE, up to 64 characters');
  if (db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(input.name)) throw new SecretNameTakenError(input.name);
  const now = new Date().toISOString();
  const row: SecretRow = {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? '',
    ciphertext: encryptDatabaseSecret(db, input.value),
    version: 1,
    created_at: now,
    updated_at: now,
    rotated_at: null,
    revoked_at: null,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO secrets (id, name, description, ciphertext, version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(row.id, row.name, row.description, row.ciphertext, actor.type === 'user' ? actor.id : null, now, now);
    audit(db, row, 'created', actor);
  })();
  return metadata(db, row);
}

/** Everything that depends on a secret: what it was granted to, and what names it in configuration. */
export function secretDependents(db: Database, id: string): SecretDependent[] {
  const row = rowById(db, id);
  const granted = grantsOf(db, id).map((grant): SecretDependent => ({
    type: grant.type,
    id: grant.id,
    name: granteeNames.get(grant.type)?.(db, grant.id) ?? grant.id,
    via: 'grant',
  }));
  const referenced = scanners.flatMap((scan) => scan(db, row.name));
  return [...granted, ...referenced];
}

/**
 * Renames or re-describes a secret. A rename breaks every configuration that
 * refers to the old name, so it is refused while there are any unless forced.
 */
export function updateSecret(
  db: Database,
  id: string,
  input: { name?: string; description?: string },
  actor: SecretActor,
  options: { force?: boolean } = {},
): SecretMetadata {
  const row = rowById(db, id);
  const name = input.name ?? row.name;
  if (name !== row.name) {
    if (!SECRET_NAME.test(name)) throw new Error('secret names are UPPER_SNAKE_CASE, up to 64 characters');
    if (db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(name)) throw new SecretNameTakenError(name);
    const referenced = scanners.flatMap((scan) => scan(db, row.name));
    if (referenced.length && !options.force) throw new SecretInUseError(referenced);
  }
  db.transaction(() => {
    db.prepare('UPDATE secrets SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(
      name, input.description ?? row.description, new Date().toISOString(), id,
    );
    if (name !== row.name) audit(db, { id, name }, 'renamed', actor, { from: row.name });
    if (input.description !== undefined && input.description !== row.description) audit(db, { id, name }, 'described', actor);
  })();
  return getSecret(db, id)!;
}

/** Replaces the value. Everything granted the secret gets the new one on its next use. */
export function rotateSecret(db: Database, id: string, value: string, actor: SecretActor): SecretMetadata {
  const row = rowById(db, id);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      'UPDATE secrets SET ciphertext = ?, version = version + 1, rotated_at = ?, revoked_at = NULL, updated_at = ? WHERE id = ?',
    ).run(encryptDatabaseSecret(db, value), now, now, id);
    audit(db, row, row.revoked_at ? 'restored' : 'rotated', actor, { version: row.version + 1 });
  })();
  return getSecret(db, id)!;
}

/** Destroys the value but keeps the record and its grants, so it can be rotated back in. */
export function revokeSecret(db: Database, id: string, actor: SecretActor): SecretMetadata {
  const row = rowById(db, id);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE secrets SET ciphertext = NULL, revoked_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    audit(db, row, 'revoked', actor);
  })();
  return getSecret(db, id)!;
}

/** Deletes a secret, refusing while anything depends on it unless forced. */
export function deleteSecret(db: Database, id: string, actor: SecretActor, options: { force?: boolean } = {}): void {
  const row = rowById(db, id);
  const dependents = secretDependents(db, id);
  if (dependents.length && !options.force) throw new SecretInUseError(dependents);
  db.transaction(() => {
    db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
    audit(db, row, 'deleted', actor, { dependents: dependents.length });
  })();
}

export function setSecretGrants(db: Database, id: string, grants: Grantee[], actor: SecretActor): SecretMetadata {
  const row = rowById(db, id);
  const key = (grant: Grantee) => `${grant.type}\u0000${grant.id}`;
  const before = new Map(grantsOf(db, id).map((grant) => [key(grant), grant]));
  const after = new Map(grants.map((grant) => [key(grant), grant]));
  db.transaction(() => {
    const now = new Date().toISOString();
    for (const [k, grant] of after) {
      if (before.has(k)) continue;
      db.prepare('INSERT INTO secret_grants (secret_id, grantee_type, grantee_id, created_at) VALUES (?, ?, ?, ?)')
        .run(id, grant.type, grant.id, now);
      audit(db, row, 'granted', actor, { grantee: grant });
    }
    for (const [k, grant] of before) {
      if (after.has(k)) continue;
      db.prepare('DELETE FROM secret_grants WHERE secret_id = ? AND grantee_type = ? AND grantee_id = ?')
        .run(id, grant.type, grant.id);
      audit(db, row, 'ungranted', actor, { grantee: grant });
    }
  })();
  return getSecret(db, id)!;
}

/**
 * The value of a secret, for a grantee that was given it. Every successful
 * read is audited with who read it; a refusal says why without revealing more.
 */
export function readSecretFor(db: Database, name: string, grantee: Grantee): string {
  const row = db.prepare('SELECT * FROM secrets WHERE name = ?').get(name) as SecretRow | undefined;
  if (!row) throw new SecretAccessError(`secret ${name} does not exist`);
  const granted = db
    .prepare('SELECT 1 FROM secret_grants WHERE secret_id = ? AND grantee_type = ? AND grantee_id = ?')
    .get(row.id, grantee.type, grantee.id);
  if (!granted) throw new SecretAccessError(`secret ${name} has not been granted to this ${grantee.type.replace('_', ' ')}`);
  if (row.ciphertext === null) throw new SecretAccessError(`secret ${name} has been revoked`);
  audit(db, row, 'accessed', { type: grantee.type, id: grantee.id }, { version: row.version });
  return decryptDatabaseSecret(db, row.ciphertext);
}

/** Replaces every `{{secret:NAME}}` in a string with the value, for a grantee that holds them all. */
export function resolveSecretReferences(db: Database, text: string, grantee: Grantee): string {
  const names = findSecretReferences(text);
  if (names.length === 0) return text;
  const values = new Map(names.map((name) => [name, readSecretFor(db, name, grantee)]));
  return text.replace(REFERENCE, (_match, name: string) => values.get(name)!);
}

export interface SecretAuditEntry {
  id: string;
  secretId: string;
  secretName: string;
  action: string;
  actor: SecretActor;
  detail: Record<string, unknown>;
  at: string;
}

export function listSecretAudit(db: Database, filter: { secretId?: string; limit: number }): SecretAuditEntry[] {
  const rows = (filter.secretId
    ? db.prepare('SELECT * FROM secret_audit WHERE secret_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(filter.secretId, filter.limit)
    : db.prepare('SELECT * FROM secret_audit ORDER BY created_at DESC, rowid DESC LIMIT ?').all(filter.limit)) as Array<{
      id: string; secret_id: string; secret_name: string; action: string; actor_type: SecretActor['type']; actor_id: string | null; detail: string; created_at: string;
    }>;
  return rows.map((row) => ({
    id: row.id,
    secretId: row.secret_id,
    secretName: row.secret_name,
    action: row.action,
    actor: { type: row.actor_type, id: row.actor_id },
    detail: JSON.parse(row.detail),
    at: row.created_at,
  }));
}
