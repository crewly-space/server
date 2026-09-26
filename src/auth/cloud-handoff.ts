import { createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { ensureDefaultChannel } from '../channels/repository.js';
import { createUser, getUserByEmail, getUserById, type AvatarMode, type Role, type UserRow } from '../users/repository.js';

/** What Crewly Cloud says about the person arriving. */
export interface HandoffClaims {
  deploymentId: string;
  cloudUserId: string;
  email: string;
  displayName: string;
  avatarMode?: AvatarMode;
  orgRole: Role;
  nonce: string;
  iat: number;
  exp: number;
}

export interface CloudHandoffConfig {
  /** Base64 SPKI Ed25519 key, published by the Cloud that provisioned this server. */
  publicKey: string;
  /** This server's own deployment id; a token minted for another one is not ours. */
  deploymentId: string;
}

export const CLOUD_IDENTITY_PROVIDER = 'crewly-cloud';

/**
 * The longest handoff this server will honour.
 *
 * Cloud mints two-minute tokens. Refusing anything longer means a Cloud that
 * is talked into a generous expiry still cannot hand out a long-lived key to
 * this server.
 */
const MAX_LIFETIME_SECONDS = 300;
/** Tolerates the clocks of two machines disagreeing by a little. */
const CLOCK_SKEW_SECONDS = 60;

const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export class HandoffRejected extends Error {}

function decodeKey(base64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
}

/**
 * Checks the token and returns what it claims, or throws.
 *
 * Ed25519 over `v1.<payload>`. There is no algorithm field to negotiate, so
 * there is nothing to talk this verifier into accepting.
 */
export function verifyHandoffToken(token: string, config: CloudHandoffConfig, now = new Date()): HandoffClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new HandoffRejected('malformed token');
  const [version, payload, signature] = parts;

  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(`${version}.${payload}`),
      decodeKey(config.publicKey),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    throw new HandoffRejected('unverifiable token');
  }
  if (!valid) throw new HandoffRejected('bad signature');

  let claims: HandoffClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as HandoffClaims;
  } catch {
    throw new HandoffRejected('unreadable claims');
  }

  const expected = Buffer.from(config.deploymentId);
  const received = Buffer.from(String(claims.deploymentId ?? ''));
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new HandoffRejected('token belongs to another server');
  }
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) throw new HandoffRejected('no email');
  if (typeof claims.cloudUserId !== 'string' || !claims.cloudUserId) throw new HandoffRejected('no subject');
  if (typeof claims.nonce !== 'string' || claims.nonce.length < 16) throw new HandoffRejected('no nonce');
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) throw new HandoffRejected('no lifetime');

  const seconds = Math.floor(now.getTime() / 1000);
  if (claims.exp <= seconds) throw new HandoffRejected('expired');
  if (claims.iat > seconds + CLOCK_SKEW_SECONDS) throw new HandoffRejected('issued in the future');
  if (claims.exp - claims.iat > MAX_LIFETIME_SECONDS) throw new HandoffRejected('lifetime is too long');

  return claims;
}

/** True the first time a nonce is seen; false for a replay. */
export function consumeNonce(db: Database, nonce: string, expiresAt: Date, now = new Date()): boolean {
  db.prepare('DELETE FROM handoff_nonces WHERE expires_at <= ?').run(now.toISOString());
  try {
    db.prepare('INSERT INTO handoff_nonces (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt.toISOString());
    return true;
  } catch {
    return false;
  }
}

/**
 * The account this handoff belongs to, created or linked as needed.
 *
 * A role is only ever raised. Cloud says what somebody is in the workspace
 * that pays for this server; it does not get to take away what this server
 * granted, or the first owner could be demoted from outside.
 */
export function applyHandoff(db: Database, claims: HandoffClaims, onFirstUser?: () => void): UserRow {
  const email = claims.email.trim().toLowerCase();
  const displayName = claims.displayName?.trim() || email;

  const apply = db.transaction((): UserRow => {
    const link = db
      .prepare('SELECT user_id FROM external_identities WHERE provider = ? AND subject = ?')
      .get(CLOUD_IDENTITY_PROVIDER, claims.cloudUserId) as { user_id: string } | undefined;

    const existing = link ? getUserById(db, link.user_id) : getUserByEmail(db, email);
    const firstUser = (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count === 0;
    // The person who buys a server is its owner, whatever Cloud calls them in
    // the workspace. Anyone arriving later gets the role Cloud gives them.
    const arrivingRole: Role = firstUser ? 'owner' : claims.orgRole;

    if (!existing) {
      const created = createUser(db, {
        email,
        displayName,
        // Cloud is the only way into this account until somebody sets one here.
        passwordHash: null,
        role: arrivingRole,
      });
      db.prepare(
        'INSERT INTO external_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)',
      ).run(CLOUD_IDENTITY_PROVIDER, claims.cloudUserId, created.id, new Date().toISOString());
      if (firstUser) {
        ensureDefaultChannel(db, { id: created.id, role: created.role });
        onFirstUser?.();
      }
      return created;
    }

    if (!link) {
      db.prepare(
        'INSERT INTO external_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)',
      ).run(CLOUD_IDENTITY_PROVIDER, claims.cloudUserId, existing.id, new Date().toISOString());
    }
    const role: Role = ROLE_RANK[arrivingRole] > ROLE_RANK[existing.role] ? arrivingRole : existing.role;
    db.prepare('UPDATE users SET display_name = ?, role = ?, avatar_mode = COALESCE(?, avatar_mode) WHERE id = ?')
      .run(displayName, role, claims.avatarMode ?? null, existing.id);
    return getUserById(db, existing.id)!;
  });

  return apply();
}
