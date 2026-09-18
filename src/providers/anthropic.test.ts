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

  it('lists a non-empty set of models with positive context windows', async () => {
    const client = new AnthropicClient('sk-test');
    const models = await client.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });
});
