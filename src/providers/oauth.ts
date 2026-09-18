import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/driver.js';

/**
 * Connecting a model provider by signing in to it, instead of pasting a key.
 *
 * OpenRouter is the provider that supports this today: an authorization code
 * flow with PKCE that mints a fresh API key scoped to this OpenCrew server. No
 * client registration is needed, so a self-hosted install can use it with no
 * operator configuration at all.
 *
 * The server keeps the code verifier. The browser only ever carries the state,
 * which is single-use and bound to the user who started the flow.
 */

export type OAuthProviderKind = 'openrouter';

export const OAUTH_CAPABLE_PROVIDER_KINDS: readonly OAuthProviderKind[] = ['openrouter'];

const STATE_TTL_MS = 10 * 60 * 1000;

const base64Url = (input: Buffer): string =>
  input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface PendingProviderAuthorization {
  state: string;
  authorizeUrl: string;
}

interface StateRow {
  state: string;
  provider_kind: string;
  provider_id: string;
  code_verifier: string;
  user_id: string;
  expires_at: string;
}

export class ProviderOAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'ProviderOAuthError';
  }
}

/**
 * Start a connect flow.
 *
 * `callbackUrl` is where the provider sends the browser back, which is a page
 * in the OpenCrew app rather than an API route: the app authenticates with a
 * bearer token that a redirect would not carry.
 */
export function startProviderAuthorization(
  db: Database,
  input: { kind: OAuthProviderKind; providerId: string; userId: string; callbackUrl: string }
): PendingProviderAuthorization {
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const now = Date.now();

  db.prepare('DELETE FROM provider_oauth_states WHERE expires_at <= ?').run(new Date(now).toISOString());
  db.prepare(
    `INSERT INTO provider_oauth_states
       (state, provider_kind, provider_id, code_verifier, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    state,
    input.kind,
    input.providerId,
    codeVerifier,
    input.userId,
    new Date(now).toISOString(),
    new Date(now + STATE_TTL_MS).toISOString()
  );

  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('callback_url', input.callbackUrl);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { state, authorizeUrl: url.toString() };
}

/** Redeem a state exactly once, for the user who started it. */
export function consumeProviderState(
  db: Database,
  input: { state: string; userId: string }
): { kind: OAuthProviderKind; providerId: string; codeVerifier: string } {
  const row = db
    .prepare('SELECT * FROM provider_oauth_states WHERE state = ?')
    .get(input.state) as StateRow | undefined;
  if (row) db.prepare('DELETE FROM provider_oauth_states WHERE state = ?').run(input.state);

  if (!row) throw new ProviderOAuthError('this connection attempt is no longer valid', 400);

  // Bound to its user: another signed-in account must not be able to redeem
  // someone else's authorization and attach the resulting key.
  if (row.user_id !== input.userId) {
    throw new ProviderOAuthError('this connection attempt is no longer valid', 400);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new ProviderOAuthError('this connection attempt has expired, start again', 400);
  }

  const provided = Buffer.from(input.state);
  const stored = Buffer.from(row.state);
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) {
    throw new ProviderOAuthError('this connection attempt is no longer valid', 400);
  }

  return {
    kind: row.provider_kind as OAuthProviderKind,
    providerId: row.provider_id,
    codeVerifier: row.code_verifier,
  };
}

/** Trade the authorization code for an API key the server can store. */
export async function exchangeProviderCode(
  input: { kind: OAuthProviderKind; code: string; codeVerifier: string },
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: input.code,
        code_verifier: input.codeVerifier,
        code_challenge_method: 'S256',
      }),
    });
  } catch (err) {
    throw new ProviderOAuthError(`could not reach the provider: ${(err as Error).message}`, 502);
  }

  if (!response.ok) {
    throw new ProviderOAuthError(`the provider rejected the authorization (status ${response.status})`, 502);
  }

  const payload = (await response.json().catch(() => ({}))) as { key?: string };
  if (!payload.key) throw new ProviderOAuthError('the provider did not return an API key', 502);
  return payload.key;
}
