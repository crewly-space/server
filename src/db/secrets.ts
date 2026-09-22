import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './driver.js';

const KEY_BYTES = 32;
const PREFIX = 'enc:v1:';
const keys = new WeakMap<Database, Buffer>();

export function registerDatabaseSecretKey(db: Database, key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error('database secret key must be 32 bytes');
  keys.set(db, Buffer.from(key));
}

export function loadOrCreateDatabaseSecretKey(dataDir: string): Buffer {
  const filename = path.join(dataDir, 'secrets.key');
  try {
    const existing = fs.readFileSync(filename);
    if (existing.length !== KEY_BYTES) {
      throw new Error(`${filename} is invalid; expected a ${KEY_BYTES}-byte key`);
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const generated = randomBytes(KEY_BYTES);
  try {
    fs.writeFileSync(filename, generated, { flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    // Another server process may have won the first-boot race. Never overwrite
    // that key: doing so would make already-written credentials unreadable.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(filename);
    if (existing.length !== KEY_BYTES) {
      throw new Error(`${filename} is invalid; expected a ${KEY_BYTES}-byte key`);
    }
    return existing;
  }
}

const MANAGED_MARKER = 'secrets.key.managed';

function fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * The key a server encrypts its secrets with.
 *
 * Self-hosted: generated on first boot into `<dataDir>/secrets.key` (0600).
 * Managed (Crewly Cloud): `CREWLY_SECRETS_KEY` from the platform's secret
 * store, never written to disk; only its fingerprint is, so a later boot
 * with a different key -- or with none, which would quietly mint a new one
 * and orphan every stored secret -- refuses to start instead.
 */
export function resolveDatabaseSecretKey(dataDir: string, managedKeyBase64?: string): Buffer {
  const markerFile = path.join(dataDir, MANAGED_MARKER);
  const marker = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8').trim() : null;
  if (!managedKeyBase64) {
    if (marker) {
      throw new Error('This server encrypts its secrets with a managed key; set CREWLY_SECRETS_KEY to start it');
    }
    return loadOrCreateDatabaseSecretKey(dataDir);
  }

  const managed = Buffer.from(managedKeyBase64, 'base64');
  if (managed.length !== KEY_BYTES) throw new Error(`CREWLY_SECRETS_KEY must be ${KEY_BYTES} bytes, base64-encoded`);
  const localFile = path.join(dataDir, 'secrets.key');
  if (fs.existsSync(localFile)) {
    const local = fs.readFileSync(localFile);
    if (local.length !== managed.length || !timingSafeEqual(local, managed)) {
      throw new Error('CREWLY_SECRETS_KEY is not the key this server already encrypted its secrets with (secrets.key)');
    }
  }
  if (marker && marker !== fingerprint(managed)) {
    throw new Error('CREWLY_SECRETS_KEY is not the key this server already encrypted its secrets with');
  }
  if (!marker) fs.writeFileSync(markerFile, `${fingerprint(managed)}\n`, { mode: 0o600 });
  return managed;
}

function keyFor(db: Database): Buffer {
  const existing = keys.get(db);
  if (existing) return existing;
  // In-memory databases are used throughout the route and repository tests.
  // Their key only needs to live as long as the Database object does.
  const ephemeral = randomBytes(KEY_BYTES);
  keys.set(db, ephemeral);
  return ephemeral;
}

export function encryptDatabaseSecret(db: Database, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(db), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptDatabaseSecret(db: Database, stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // Legacy plaintext is migrated on the next update.
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('encrypted database secret is malformed');
  const [ivValue, tagValue, ciphertextValue] = parts as [string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', keyFor(db), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function isEncryptedDatabaseSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Upgrades credentials written by pre-encryption Crewly releases in place. */
export function encryptLegacyProviderSecrets(db: Database): number {
  const rows = db.prepare(
    'SELECT id, api_key FROM provider_configs WHERE api_key IS NOT NULL'
  ).all() as Array<{ id: string; api_key: string }>;
  const legacy = rows.filter((row) => !isEncryptedDatabaseSecret(row.api_key));
  const update = db.prepare('UPDATE provider_configs SET api_key = ? WHERE id = ? AND api_key = ?');
  db.transaction(() => {
    for (const row of legacy) {
      update.run(encryptDatabaseSecret(db, row.api_key), row.id, row.api_key);
    }
  })();
  return legacy.length;
}
