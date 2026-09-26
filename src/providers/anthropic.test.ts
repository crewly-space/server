import { describe, expect, it, vi } from 'vitest';
import { AnthropicClient } from './anthropic.js';
import { ProviderAuthError, ProviderRateLimitError, ProviderUnavailableError } from './errors.js';

describe('AnthropicClient', () => {
  it('sends the request and maps a successful response', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'hello there' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200 }
      )
    );
    const client = new AnthropicClient('sk-test', fakeFetch as unknown as typeof fetch);

    const response = await client.chat({
      providerId: 'anthropic-default',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.content).toBe('hello there');
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'sk-test' }),
      })
    );
  });

  it('throws ProviderAuthError on a 401 response', async () => {
    const fakeFetch = vi.fn(async () => new Response('{}', { status: 401 }));
    const client = new AnthropicClient('bad-key', fakeFetch as unknown as typeof fetch);
    await expect(
      client.chat({ providerId: 'anthropic-default', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(ProviderAuthError);
  });

  it('throws ProviderRateLimitError on a 429 response', async () => {
    const fakeFetch = vi.fn(async () => new Response('{}', { status: 429 }));
    const client = new AnthropicClient('sk-test', fakeFetch as unknown as typeof fetch);
    await expect(
      client.chat({ providerId: 'anthropic-default', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(ProviderRateLimitError);
  });

  it('throws ProviderUnavailableError when the network request itself fails', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new AnthropicClient('sk-test', fakeFetch as unknown as typeof fetch);
    await expect(
      client.chat({ providerId: 'anthropic-default', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it('lists models from /v1/models with their display names, stamped with the connection id', async () => {
    const fakeFetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      data: [
        { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5' },
        { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
      ],
    }), { status: 200 }));
    const client = new AnthropicClient('sk-test', fakeFetch as unknown as typeof fetch);
    const models = await client.listModels('anthropic-work');
    expect(fakeFetch.mock.calls[0]![0]).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect((fakeFetch.mock.calls[0]![1]!.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect(models).toEqual([
      { id: 'claude-opus-5', providerId: 'anthropic-work', displayName: 'Claude Opus 5', contextWindow: 200000 },
      { id: 'claude-haiku-4-5', providerId: 'anthropic-work', displayName: 'Claude Haiku 4.5', contextWindow: 200000 },
    ]);
  });

  it('reports a rejected key while listing models as an auth failure', async () => {
    const fakeFetch = vi.fn(async () => new Response('{}', { status: 401 }));
    const client = new AnthropicClient('sk-bad', fakeFetch as unknown as typeof fetch);
    await expect(client.listModels()).rejects.toThrow(ProviderAuthError);
  });
});
