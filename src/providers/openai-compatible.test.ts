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

  it('reads OpenRouter names and context lengths, and stamps the connection id', async () => {
    const fakeFetch = vi.fn(async (_url: string) => new Response(JSON.stringify({
      data: [
        { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', context_length: 1000000 },
        { id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 Mini', context_length: 400000 },
        { id: 'openai/gpt-5-mini', name: 'duplicate' },
        { name: 'no id, skipped' },
      ],
    }), { status: 200 }));
    const client = new OpenAICompatibleClient('openrouter', 'https://openrouter.ai/api/v1/', 'sk-or', fakeFetch as unknown as typeof fetch);
    const models = await client.listModels('openrouter');
    // A trailing slash on the saved base URL must not produce `//models`.
    expect(fakeFetch.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/models');
    expect(models).toEqual([
      { id: 'anthropic/claude-sonnet-5', providerId: 'openrouter', displayName: 'Anthropic: Claude Sonnet 5', contextWindow: 1000000 },
      { id: 'openai/gpt-5-mini', providerId: 'openrouter', displayName: 'OpenAI: GPT-5 Mini', contextWindow: 400000 },
    ]);
  });

  it('accepts a bare array from a compatible server', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify([{ id: 'local-model' }]), { status: 200 }));
    const client = new OpenAICompatibleClient('openai-compatible', 'http://localhost:8080/v1', 'k', fakeFetch as unknown as typeof fetch);
    expect((await client.listModels('mine')).map((m) => [m.id, m.providerId])).toEqual([['local-model', 'mine']]);
  });

  it('tells an unsupported model list, a bad key and an unreadable answer apart', async () => {
    const respond = (status: number, body = '{}') =>
      new OpenAICompatibleClient('openrouter', 'https://x/v1', 'k', (async () => new Response(body, { status })) as unknown as typeof fetch);
    await expect(respond(404).listModels()).rejects.toThrow(ProviderModelsUnsupportedError);
    await expect(respond(401).listModels()).rejects.toThrow(ProviderAuthError);
    await expect(respond(429).listModels()).rejects.toThrow(ProviderRateLimitError);
    await expect(respond(503).listModels()).rejects.toThrow(ProviderUnavailableError);
    await expect(respond(200, '<html>').listModels()).rejects.toThrow(ProviderInvalidResponseError);
    await expect(respond(200, '{"object":"list"}').listModels()).rejects.toThrow(ProviderInvalidResponseError);
  });
});
