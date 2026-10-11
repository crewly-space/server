import type { Database } from '../db/driver.js';
import { crewlyServiceCredential, crewlyServiceRequest, CrewlyConnectionError } from '../crewly/connection.js';
import { ConnectorOAuthError, type ConnectorProvider } from './providers.js';

/*
 * Sign-in to GitHub, Linear and the rest through Crewly's own OAuth apps.
 *
 * Registering an OAuth app per provider is the hardest part of connecting a
 * server to anything, so a server connected to Crewly with the `connectors`
 * scope -- every hosted one, and any self-hosted one that opts in -- can skip
 * it. The server still builds the authorize URL and keeps the state and the
 * PKCE verifier; Crewly only lends its client id, receives the provider's
 * redirect, and performs the code exchange that needs the client secret. The
 * token then lives here, like any other connector's.
 *
 * An OAuth app the admin configured on this server always wins.
 */

export const BROKER_SCOPE = 'connectors';
const CACHE_MS = 5 * 60 * 1000;

let cached: { key: string; at: number; providers: Set<string> } | undefined;

/** Which providers Crewly can sign in to for this server. Empty when not connected with `connectors`. */
export async function brokeredProviders(db: Database, fetchImpl: typeof fetch): Promise<Set<string>> {
  const connection = crewlyServiceCredential(db, BROKER_SCOPE);
  if (!connection) return new Set();
  const key = `${connection.cloudUrl}|${connection.instanceId}`;
  if (cached && cached.key === key && Date.now() - cached.at < CACHE_MS) return cached.providers;
  try {
    const { status, body } = await crewlyServiceRequest(db, fetchImpl, BROKER_SCOPE, 'GET', '/api/v1/instance/connectors');
    const list = status === 200 && Array.isArray(body.providers) ? body.providers : [];
    const providers = new Set(list.map((entry) => String((entry as { provider?: unknown }).provider ?? '')).filter(Boolean));
    cached = { key, at: Date.now(), providers };
    return providers;
  } catch {
    // Crewly being unreachable means "not available right now", not an error
    // on a page that only lists what can be connected.
    return new Set();
  }
}

/** Forgets the cached list; tests and a changed connection call this. */
export function resetBrokerCache(): void {
  cached = undefined;
}

function brokerError(status: number, body: Record<string, unknown>, fallback: string): ConnectorOAuthError {
  const message = typeof body.error === 'string' ? body.error : fallback;
  return new ConnectorOAuthError(message, status === 401 || status === 403 ? 409 : status >= 500 ? 502 : 400);
}

/** Asks Crewly for its client id, its callback and a state for one sign-in that returns to `returnUrl`. */
export async function startBrokeredAuthorization(
  db: Database,
  fetchImpl: typeof fetch,
  provider: ConnectorProvider,
  returnUrl: string,
): Promise<{ state: string; clientId: string; redirectUri: string }> {
  let result;
  try {
    result = await crewlyServiceRequest(db, fetchImpl, BROKER_SCOPE, 'POST', `/api/v1/instance/connectors/${provider}/authorize`, { returnUrl });
  } catch (error) {
    if (error instanceof CrewlyConnectionError) throw new ConnectorOAuthError(error.message, error.statusCode);
    throw error;
  }
  const { status, body } = result;
  if (status !== 201 || typeof body.state !== 'string' || typeof body.clientId !== 'string' || typeof body.redirectUri !== 'string') {
    throw brokerError(status, body, 'Crewly could not start this sign-in');
  }
  return { state: body.state, clientId: body.clientId, redirectUri: body.redirectUri };
}

/**
 * A fetch for the provider's `exchange…Code` function: its token request goes
 * to Crewly instead, which adds the secret, asks the provider and returns the
 * provider's answer as it was. The exchange code then reads it as usual.
 */
export function brokeredTokenFetch(
  db: Database,
  fetchImpl: typeof fetch,
  provider: ConnectorProvider,
  input: { state: string; code: string; codeVerifier: string },
): typeof fetch {
  return relayedFetch(db, fetchImpl, `/api/v1/instance/connectors/${provider}/token`, input);
}

/** The same for renewing a token that Crewly's OAuth app issued. */
export function brokeredRefreshFetch(db: Database, fetchImpl: typeof fetch, provider: ConnectorProvider, refreshToken: string): typeof fetch {
  return relayedFetch(db, fetchImpl, `/api/v1/instance/connectors/${provider}/refresh`, { refreshToken });
}

function relayedFetch(db: Database, fetchImpl: typeof fetch, path: string, input: Record<string, unknown>): typeof fetch {
  return (async () => {
    let result;
    try {
      result = await crewlyServiceRequest(db, fetchImpl, BROKER_SCOPE, 'POST', path, input);
    } catch (error) {
      if (error instanceof CrewlyConnectionError) throw new ConnectorOAuthError(error.message, error.statusCode);
      throw error;
    }
    const { status, body } = result;
    if (status !== 200 || typeof body.status !== 'number' || typeof body.body !== 'object' || body.body === null) {
      throw brokerError(status, body, 'Crewly could not reach the provider for this connection');
    }
    return new Response(JSON.stringify(body.body), { status: body.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
