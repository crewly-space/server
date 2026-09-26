import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleClient } from './openai-compatible.js';
import {
  ProviderAuthError,
  ProviderInvalidResponseError,
  ProviderModelsUnsupportedError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from './errors.js';

describe('OpenAICompatibleClient', () => {
  it('sends the request and maps a successful chat response', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hi from openai' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        }),
        { status: 200 }
      )
    );
    const client = new OpenAICompatibleClient('openai', 'https://api.openai.com/v1', 'sk-test', fakeFetch as unknown as typeof fetch);

    const response = await client.chat({
      providerId: 'openai-default',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.content).toBe('hi from openai');
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 3 });
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      })
    );
  });

  it('throws ProviderAuthError on a 401 response', async () => {
    const fakeFetch = vi.fn(async () => new Response('{}', { status: 401 }));
    const client = new OpenAICompatibleClient('openai', 'https://api.openai.com/v1', 'bad-key', fakeFetch as unknown as typeof fetch);
    await expect(
      client.chat({ providerId: 'openai-default', model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(ProviderAuthError);
  });

  it('throws ProviderRateLimitError on a 429 response', async () => {
    const fakeFetch = vi.fn(async () => new Response('{}', { status: 429 }));
    const client = new OpenAICompatibleClient('openai', 'https://api.openai.com/v1', 'sk-test', fakeFetch as unknown as typeof fetch);
    await expect(
      client.chat({ providerId: 'openai-default', model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(ProviderRateLimitError);
  });

  it('throws ProviderUnavailableError when the network request itself fails', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new OpenAICompatibleClient('deepseek', 'https://api.deepseek.com/v1', 'sk-test', fakeFetch as unknown as typeof fetch);
    await expect(
      client.chat({ providerId: 'deepseek-default', model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it('throws ProviderUnavailableError (not a TypeError) when a 200 response has no choices', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const client = new OpenAICompatibleClient('openai', 'https://api.openai.com/v1', 'sk-test', fakeFetch as unknown as typeof fetch);
    await expect(
      client.chat({ providerId: 'openai-default', model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it('lists models from the /models endpoint', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] }), { status: 200 }));
    const client = new OpenAICompatibleClient('openai', 'https://api.openai.com/v1', 'sk-test', fakeFetch as unknown as typeof fetch);
    const models = await client.listModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-mini']);
  });

  it('normalizes array and named model responses with context metadata', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify([
      { id: 'qwen/qwen3-32b', name: 'Qwen 3 32B', context_length: 131072 },
      { id: 'custom-model', max_context_length: 8192 },
    ]), { status: 200 }));
    const client = new OpenAICompatibleClient('openrouter', 'https://openrouter.ai/api/v1', 'sk-test', fakeFetch as unknown as typeof fetch);
    await expect(client.listModels()).resolves.toEqual([
      { id: 'qwen/qwen3-32b', providerId: 'openrouter', displayName: 'Qwen 3 32B', contextWindow: 131072 },
      { id: 'custom-model', providerId: 'openrouter', displayName: 'custom-model', contextWindow: 8192 },
    ]);
  });
});
