import type { ProviderConfigRecord } from './repository.js';
import type { ProviderClient } from './client.js';
import { AgentdBackedProviderClient } from './agentd.js';
import { AnthropicClient } from './anthropic.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import type { Database } from '../db/driver.js';
import type { DeviceConnectionHub } from '../devices/hub.js';

const DEFAULT_BASE_URLS: Record<'openai' | 'openrouter' | 'deepseek', string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

export interface AgentdProviderContext { db: Database; hub: DeviceConnectionHub; ownerUserId: string }

export function resolveProviderClient(
  config: ProviderConfigRecord,
  fetchImpl: typeof fetch = fetch,
  agentd?: AgentdProviderContext,
): ProviderClient {
  switch (config.kind) {
    case 'anthropic':
      if (!config.apiKey) throw new Error(`provider "${config.id}" is missing an apiKey`);
      return config.baseUrl
        ? new AnthropicClient(config.apiKey, fetchImpl, config.baseUrl)
        : new AnthropicClient(config.apiKey, fetchImpl);
    case 'openai':
    case 'openrouter':
    case 'deepseek': {
      if (!config.apiKey) throw new Error(`provider "${config.id}" is missing an apiKey`);
      const baseUrl = config.baseUrl ?? DEFAULT_BASE_URLS[config.kind];
      return new OpenAICompatibleClient(config.kind, baseUrl, config.apiKey, fetchImpl);
    }
    case 'openai-compatible':
      if (!config.apiKey) throw new Error(`provider "${config.id}" is missing an apiKey`);
      if (!config.baseUrl) throw new Error(`provider "${config.id}" (openai-compatible) requires a baseUrl`);
      return new OpenAICompatibleClient('openai-compatible', config.baseUrl, config.apiKey, fetchImpl);
    case 'claude-subscription':
    case 'ollama':
      if (!agentd) throw new Error(`provider "${config.id}" requires a paired device context`);
      return new AgentdBackedProviderClient(config.kind, config.id, agentd.ownerUserId, agentd.db, agentd.hub);
  }
}
