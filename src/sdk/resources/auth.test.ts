import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { AuthResource } from './auth.js';

function clientWithFetch(handler: (method: string, path: string, body: unknown) => Response): HttpClient {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(init?.method ?? 'GET', path, body);
  }) as unknown as typeof fetch;
  return new HttpClient('http://localhost:4000', fetchImpl);
}

describe('AuthResource', () => {
  it('setup posts to /api/v1/auth/setup and returns the token and user', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/auth/setup');
      expect(body).toEqual({ email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' });
      return new Response(
        JSON.stringify({ token: 'tok_1', user: { id: 'u1', email: 'owner@example.com', role: 'owner' } }),
        { status: 201 }
      );
    });
    const auth = new AuthResource(http);

    const result = await auth.setup({ email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' });

    expect(result.token).toBe('tok_1');
    expect(result.user.role).toBe('owner');
  });

  it('includes the first-run claim token when one is required', async () => {
    const http = clientWithFetch((_method, _path, body) => {
      expect(body).toEqual({
        email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1', claimToken: 'claim-1',
      });
      return new Response(
        JSON.stringify({ token: 'tok_1', user: { id: 'u1', email: 'owner@example.com', role: 'owner' } }),
        { status: 201 },
      );
    });
    await new AuthResource(http).setup({
      email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1', claimToken: 'claim-1',
    });
  });

  it('login posts to /api/v1/auth/login', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/auth/login');
      return new Response(
        JSON.stringify({ token: 'tok_2', user: { id: 'u1', email: 'owner@example.com', role: 'owner' } }),
        { status: 200 }
      );
    });
    const auth = new AuthResource(http);

    const result = await auth.login({ email: 'owner@example.com', password: 'super-secret-1' });

    expect(result.token).toBe('tok_2');
  });

  it('me gets /api/v1/auth/me', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/auth/me');
      return new Response(JSON.stringify({ id: 'u1', email: 'owner@example.com', role: 'owner' }), { status: 200 });
    });
    const auth = new AuthResource(http);

    const me = await auth.me();

    expect(me.id).toBe('u1');
  });
});
