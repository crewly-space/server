import type { ModelInfo, ProviderKind } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface ProviderConfigPublic {
  id: string;
  kind: ProviderKind;
  baseUrl: string | null;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProviderInput {
  id: string;
  kind: ProviderKind;
  apiKey?: string;
  baseUrl?: string;
}

export interface UpdateProviderInput {
  apiKey?: string;
  baseUrl?: string;
}

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down' | 'rate_limited' | 'unknown';

/** What a member sees: enough to pick a provider, and whether it is working. */
export interface ProviderAvailability extends Pick<ProviderConfigPublic, 'id' | 'kind' | 'hasApiKey'> {
  status: ProviderHealthStatus;
  statusReason?: string;
}

/** How a provider has actually been doing over the last hour of real calls. */
export interface ProviderHealth {
  providerId: string;
  kind: ProviderKind;
  status: ProviderHealthStatus;
  reason?: string;
  window: { since: string; calls: number; errors: number; averageLatencyMs: number | null };
  lastSuccessAt: string | null;
  lastError: { code: string; at: string } | null;
  rateLimit: {
    requestsRemaining?: number;
    tokensRemaining?: number;
    resetAt?: string;
    limitedUntil?: string;
    observedAt: string;
  } | null;
  deviceConnected?: boolean;
}

/** A provider kind that can be connected by signing in instead of by key. */
export interface ProviderOAuthStart {
  state: string;
  authorizeUrl: string;
}

export class ProvidersResource {
  constructor(private readonly http: HttpClient) {}

  create(input: CreateProviderInput): Promise<ProviderConfigPublic> {
    return this.http.request('POST', '/api/v1/providers', input);
  }

  update(providerId: string, input: UpdateProviderInput): Promise<ProviderConfigPublic> {
    return this.http.request('PATCH', `/api/v1/providers/${encodePathSegment(providerId)}`, input);
  }

  delete(providerId: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/providers/${encodePathSegment(providerId)}`);
  }

  /** Provider kinds this server can connect through a sign-in flow. */
  oauthKinds(): Promise<{ kinds: ProviderKind[] }> {
    return this.http.request('GET', '/api/v1/providers/oauth/kinds');
  }

  /** Begin a sign-in connect; send the browser to the returned authorizeUrl. */
  startOAuth(input: { kind: ProviderKind; id?: string; callbackUrl: string }): Promise<ProviderOAuthStart> {
    return this.http.request('POST', '/api/v1/providers/oauth/start', input);
  }

  /** Redeem the code the provider returned, storing the minted key. */
  completeOAuth(input: { state: string; code: string }): Promise<ProviderConfigPublic> {
    return this.http.request('POST', '/api/v1/providers/oauth/complete', input);
  }

  list(): Promise<ProviderConfigPublic[]> {
    return this.http.request('GET', '/api/v1/providers');
  }

  listAvailable(): Promise<ProviderAvailability[]> {
    return this.http.request('GET', '/api/v1/providers/available');
  }

  /** Calls, errors, latency and rate limits per provider. Admins only. */
  health(): Promise<{ providers: ProviderHealth[] }> {
    return this.http.request('GET', '/api/v1/providers/health');
  }

  listModels(providerId: string): Promise<ModelInfo[]> {
    return this.http.request('GET', `/api/v1/providers/${encodePathSegment(providerId)}/models`);
  }
}
