import { ChatResponseSchema, ModelInfoSchema, type ChatRequest, type ModelInfo, type ProviderKind } from '../protocol/index.js';
import { crewlyServiceRequest, CrewlyConnectionError, getCrewlyConnection } from '../crewly/connection.js';
import type { Database } from '../db/driver.js';
import type { ProviderClient, ProviderChatResult } from './client.js';
import {
  ProviderAuthError,
  ProviderNotConfiguredError,
  ProviderRateLimitError,
  ProviderRequestError,
  ProviderUnavailableError,
} from './errors.js';

/** What the Gateway needs from this server's Crewly connection: running models and listing them. */
export const GATEWAY_SCOPES = ['inference', 'models:read'] as const;

/**
 * Where this server stands with Crewly Gateway, in the order an admin fixes
 * things: link the server, approve the link, grant it the Gateway, and only
 * then does it depend on Crewly offering models at all.
 */
export type GatewayState = 'not_linked' | 'link_pending' | 'revoked' | 'missing_scope' | 'not_offered' | 'unavailable' | 'ready';

export interface GatewayStatus {
  state: GatewayState;
  /** One sentence for the admin: what is wrong, and what to do. */
  message: string;
  cloudUrl: string | null;
  /** Scopes the connection still needs; empty unless `missing_scope`. */
  missingScopes: string[];
  /** Models the Gateway offers; only when `ready`. */
  models: ModelInfo[];
}

/** A provider credential that never leaves the connected server is enough: Cloud holds the upstream key. */
export class CrewlyGatewayClient implements ProviderClient {
  readonly kind: ProviderKind = 'crewly-gateway';

  constructor(
    private readonly db: Database,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(request: ChatRequest): Promise<ProviderChatResult> {
    const response = await this.call('inference', 'POST', '/api/v1/instance/inference', request);
    if (response.status !== 200) throw gatewayError(response.status, response.body.error);
    return ChatResponseSchema.parse(response.body) as ProviderChatResult;
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await this.call('models:read', 'GET', '/api/v1/instance/models');
    if (response.status !== 200) throw gatewayError(response.status, response.body.error);
    const body = response.body as { models?: unknown };
    return ModelInfoSchema.array().parse(body.models ?? []);
  }

  private async call(scope: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      return await crewlyServiceRequest(this.db, this.fetchImpl, scope, method, path, body);
    } catch (error) {
      if (error instanceof CrewlyConnectionError) {
        // 409: this server's link or its Gateway grant is missing; otherwise Crewly could not be reached.
        throw error.statusCode === 409
          ? new ProviderNotConfiguredError(`Crewly Gateway needs this server connected to Crewly with the AI Gateway service. ${error.message}.`)
          : new ProviderUnavailableError(error.message);
      }
      throw error;
    }
  }
}

function gatewayError(status: number, code: unknown): Error {
  const label = typeof code === 'string' ? code : 'provider_unavailable';
  if (label === 'gateway_not_configured') return new ProviderNotConfiguredError('Crewly does not offer Gateway models yet; use a provider key for now');
  if (status === 401 || label === 'provider_auth_failed') return new ProviderAuthError('Crewly Gateway authentication failed');
  if (status === 403) return new ProviderNotConfiguredError('This server is not allowed to use Crewly Gateway; grant it the AI Gateway service in Crewly');
  if (status === 429 || label === 'provider_rate_limited') return new ProviderRateLimitError('Crewly Gateway is rate limiting requests');
  if (status === 400 || label === 'provider_bad_request') return new ProviderRequestError('Crewly Gateway refused the request');
  return new ProviderUnavailableError(`Crewly Gateway is unavailable (${label})`);
}

/**
 * Checks, without side effects, whether Crewly Gateway works for this server
 * right now, by asking it for models the way an agent's first reply would.
 */
export async function gatewayStatus(db: Database, fetchImpl: typeof fetch): Promise<GatewayStatus> {
  const connection = getCrewlyConnection(db);
  const base = { cloudUrl: connection.cloudUrl, missingScopes: [] as string[], models: [] as ModelInfo[] };
  if (connection.status === 'disconnected') {
    return { ...base, state: 'not_linked', message: 'Connect this server to Crewly with the AI Gateway service, then its models appear here.' };
  }
  if (connection.status === 'pending') {
    return { ...base, state: 'link_pending', message: 'This server is waiting for its link to be approved in Crewly.' };
  }
  if (connection.status === 'revoked') {
    return { ...base, state: 'revoked', message: "This server's link to Crewly was revoked. Connect it again to use Crewly Gateway." };
  }
  const missingScopes = GATEWAY_SCOPES.filter((scope) => !connection.scopes.includes(scope));
  if (missingScopes.length) {
    return { ...base, missingScopes, state: 'missing_scope',
      message: 'This server is connected to Crewly but not allowed to use AI Gateway. Grant it the AI Gateway service in Crewly, then check again.' };
  }
  try {
    const models = await new CrewlyGatewayClient(db, fetchImpl).listModels();
    if (!models.length) return { ...base, state: 'not_offered', message: 'Crewly Gateway answered but offers no models yet.' };
    return { ...base, state: 'ready', models, message: `Crewly Gateway is ready with ${models.length} model${models.length === 1 ? '' : 's'}.` };
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) return { ...base, state: error.message.startsWith('Crewly does not offer') ? 'not_offered' : 'missing_scope', message: `${error.message}.` };
    if (error instanceof ProviderAuthError) return { ...base, state: 'revoked', message: 'Crewly no longer accepts this server. Check the connection in Crewly Cloud settings.' };
    return { ...base, state: 'unavailable', message: `Crewly Gateway could not be reached: ${error instanceof Error ? error.message : 'unknown error'}.` };
  }
}
