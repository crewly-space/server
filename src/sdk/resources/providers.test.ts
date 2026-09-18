import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { ProvidersResource } from './providers.js';

function clientWithFetch(handler: (method: string, path: string, body: unknown) => Response): HttpClient {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(init?.method ?? 'GET', path, body);
  }) as unknown as typeof fetch;
  return new HttpClient('http://localhost:4000', fetchImpl);
}

const PROVIDER_FIXTURE = {
  id: 'anthropic-default',
  kind: 'anthropic',
  baseUrl: null,
  hasApiKey: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('ProvidersResource', () => {
  it('create posts to /api/v1/providers and never sees a raw apiKey in the response type', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/providers');
      expect(body).toEqual({ id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-secret' });
      return new Response(JSON.stringify(PROVIDER_FIXTURE), { status: 201 });
    });
    const providers = new ProvidersResource(http);

    const config = await providers.create({ id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-secret' });

    expect(config.hasApiKey).toBe(true);
    expect('apiKey' in config).toBe(false);
  });

  it('list gets /api/v1/providers', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/providers');
      return new Response(JSON.stringify([PROVIDER_FIXTURE]), { status: 200 });
    });
    const providers = new ProvidersResource(http);

    const list = await providers.list();

    expect(list).toHaveLength(1);
  });

  it('listAvailable gets the redacted member-safe provider list', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/providers/available');
      return new Response(JSON.stringify([{ id: 'openai-default', kind: 'openai', hasApiKey: true }]), { status: 200 });
    });
    const providers = new ProvidersResource(http);
    expect(await providers.listAvailable()).toEqual([{ id: 'openai-default', kind: 'openai', hasApiKey: true }]);
  });

  it('updates and deletes a provider using an encoded id', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const http = clientWithFetch((method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'PATCH') return new Response(JSON.stringify(PROVIDER_FIXTURE), { status: 200 });
      return new Response(null, { status: 204 });
    });
    const providers = new ProvidersResource(http);

    await providers.update('account/primary', { apiKey: 'sk-rotated' });
    await providers.delete('account/primary');

    expect(calls).toEqual([
      { method: 'PATCH', path: '/api/v1/providers/account%2Fprimary', body: { apiKey: 'sk-rotated' } },
      { method: 'DELETE', path: '/api/v1/providers/account%2Fprimary', body: undefined },
    ]);
  });

  it('listModels gets /api/v1/providers/:id/models', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/providers/anthropic-default/models');
      return new Response(
        JSON.stringify([{ id: 'claude-sonnet-5', providerId: 'anthropic', displayName: 'Claude Sonnet 5', contextWindow: 200000 }]),
        { status: 200 }
      );
    });
    const providers = new ProvidersResource(http);

    const models = await providers.listModels('anthropic-default');

    expect(models).toHaveLength(1);
  });

  it('percent-encodes reserved characters in a provider id path segment', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/providers/provider%2Fwith%3Freserved/models');
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const providers = new ProvidersResource(http);

    await providers.listModels('provider/with?reserved');
  });
});
