import { describe, expect, it, vi } from 'vitest';
import { AgentdBackedProviderClient } from './agentd.js';
import { AnthropicClient } from './anthropic.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import { resolveProviderClient } from './registry.js';
import { openSqlite } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { DeviceConnectionHub } from '../devices/hub.js';

describe('resolveProviderClient', () => {
  it('resolves an anthropic config to an AnthropicClient', () => {
    const client = resolveProviderClient({ id: 'a', kind: 'anthropic', apiKey: 'sk-test', baseUrl: null, createdAt: '', updatedAt: '' });
    expect(client).toBeInstanceOf(AnthropicClient);
  });

  it('resolves openai/openrouter/deepseek/openai-compatible configs to OpenAICompatibleClient', () => {
    for (const kind of ['openai', 'openrouter', 'deepseek'] as const) {
      const client = resolveProviderClient({ id: 'x', kind, apiKey: 'sk-test', baseUrl: null, createdAt: '', updatedAt: '' });
      expect(client).toBeInstanceOf(OpenAICompatibleClient);
      expect(client.kind).toBe(kind);
    }
    const compatible = resolveProviderClient({
      id: 'x',
      kind: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'https://my-local-server/v1',
      createdAt: '',
      updatedAt: '',
    });
    expect(compatible).toBeInstanceOf(OpenAICompatibleClient);
  });

  it('resolves claude-subscription/ollama configs to AgentdBackedProviderClient', () => {
    const db = openSqlite(':memory:');
    runMigrations(db);
    for (const kind of ['claude-subscription', 'ollama'] as const) {
      const client = resolveProviderClient(
        { id: 'x', kind, apiKey: null, baseUrl: null, createdAt: '', updatedAt: '' },
        fetch,
        { db, hub: new DeviceConnectionHub(), ownerUserId: 'owner-1' },
      );
      expect(client).toBeInstanceOf(AgentdBackedProviderClient);
    }
    db.close();
  });

  it('forwards config.baseUrl through for anthropic-kind providers', async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 }
        )
    );
    const client = resolveProviderClient(
      { id: 'a', kind: 'anthropic', apiKey: 'sk-test', baseUrl: 'https://custom.anthropic.example', createdAt: '', updatedAt: '' },
      fakeFetch as unknown as typeof fetch
    );
    await client.chat({ providerId: 'a', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(fakeFetch).toHaveBeenCalledWith('https://custom.anthropic.example/v1/messages', expect.anything());
  });

  it('throws a plain config error (not a ProviderError) when a remote provider has no api key', () => {
    expect(() =>
      resolveProviderClient({ id: 'x', kind: 'anthropic', apiKey: null, baseUrl: null, createdAt: '', updatedAt: '' })
    ).toThrow(/missing an apiKey/);
  });

  it('throws a plain config error when an openai-compatible config has no baseUrl', () => {
    expect(() =>
      resolveProviderClient({ id: 'x', kind: 'openai-compatible', apiKey: 'sk-test', baseUrl: null, createdAt: '', updatedAt: '' })
    ).toThrow(/requires a baseUrl/);
  });
});
