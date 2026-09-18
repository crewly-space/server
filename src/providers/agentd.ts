import { ChatResponseSchema, ModelInfoSchema, type ChatRequest, type ChatResponse, type ModelInfo, type ProviderKind } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { listDevicesForUser } from '../devices/repository.js';
import { DeviceConnectionHub, DeviceRequestError, DeviceUnavailableError } from '../devices/hub.js';
import type { ProviderClient } from './client.js';
import { ProviderUnavailableError } from './errors.js';

export class AgentdBackedProviderClient implements ProviderClient {
  constructor(
    public readonly kind: ProviderKind,
    private readonly providerId: string,
    private readonly ownerUserId: string,
    private readonly db: Database,
    private readonly hub: DeviceConnectionHub,
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const result = await this.hub.request(this.deviceId(), 'provider.chat', {
        kind: this.kind, providerId: this.providerId, request,
      });
      return ChatResponseSchema.parse(result.response);
    } catch (error) {
      throw providerUnavailable(this.kind, error);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const result = await this.hub.request(this.deviceId(), 'provider.models', {
        kind: this.kind, providerId: this.providerId,
      });
      return ModelInfoSchema.array().parse(result.models);
    } catch (error) {
      throw providerUnavailable(this.kind, error);
    }
  }

  private deviceId(): string {
    const device = listDevicesForUser(this.db, this.ownerUserId).find((candidate) => {
      if (!this.hub.isConnected(candidate.id)) return false;
      try {
        const capabilities = JSON.parse(candidate.capabilities) as { providers?: Array<{ id?: string; kind?: string }> };
        return capabilities.providers?.some((provider) => provider.kind === this.kind) ?? false;
      } catch { return false; }
    });
    if (!device) throw new ProviderUnavailableError(`no connected device advertises ${this.kind}`);
    return device.id;
  }
}

function providerUnavailable(kind: ProviderKind, error: unknown): ProviderUnavailableError {
  if (error instanceof ProviderUnavailableError) return error;
  if (error instanceof DeviceRequestError || error instanceof DeviceUnavailableError) {
    return new ProviderUnavailableError(`${kind} device unavailable: ${error.message}`);
  }
  return new ProviderUnavailableError(`${kind} device returned an invalid response`);
}
