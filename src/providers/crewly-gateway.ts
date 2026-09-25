import { ChatResponseSchema, ModelInfoSchema, type ChatRequest, type ModelInfo, type ProviderKind } from '../protocol/index.js';
import { crewlyServiceRequest, CrewlyConnectionError } from '../crewly/connection.js';
import type { Database } from '../db/driver.js';
import type { ProviderClient, ProviderChatResult } from './client.js';
import {
  ProviderAuthError,
  ProviderNotConfiguredError,
  ProviderRateLimitError,
  ProviderRequestError,
  ProviderUnavailableError,
} from './errors.js';

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
      if (error instanceof CrewlyConnectionError) throw new ProviderNotConfiguredError(error.message);
      throw error;
    }
  }
}

function gatewayError(status: number, code: unknown): Error {
  const label = typeof code === 'string' ? code : 'provider_unavailable';
  if (status === 401 || label === 'provider_auth_failed') return new ProviderAuthError('Crewly Gateway authentication failed');
  if (status === 403) return new ProviderNotConfiguredError('Crewly Gateway access is not granted to this server');
  if (status === 429 || label === 'provider_rate_limited') return new ProviderRateLimitError('Crewly Gateway is rate limiting requests');
  if (status === 400 || label === 'provider_bad_request') return new ProviderRequestError('Crewly Gateway refused the request');
  return new ProviderUnavailableError(`Crewly Gateway is unavailable (${label})`);
}
