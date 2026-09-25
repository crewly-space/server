import { describe, expect, it, vi } from 'vitest';
import { CrewlyApiError } from './errors.js';
import { HttpClient } from './http-client.js';

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {})) as unknown as typeof fetch;
}

describe('HttpClient', () => {
  it('calls the default global fetch with the global as its receiver', async () => {
    // Browsers throw "Illegal invocation" when window.fetch is called with any
    // other receiver, so the default must stay bound to globalThis.
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = function boundOnlyFetch(this: unknown, url: string | URL | Request) {
      if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ initialized: false }), { status: 200 }));
    } as unknown as typeof fetch;
    try {
      const client = new HttpClient('http://localhost:4000');

      await expect(client.request('GET', '/api/v1/auth/status')).resolves.toEqual({ initialized: false });
      expect(calls).toEqual(['http://localhost:4000/api/v1/auth/status']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sends a JSON body and returns the parsed JSON response', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe('http://localhost:4000/api/v1/agents');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['x-crewly-protocol-version']).toBe('0.1.0');
      expect((init.headers as Record<string, string>)['x-crewly-client-version']).toBe('0.0.0-dev');
      expect(JSON.parse(init.body as string)).toEqual({ name: 'Assistant' });
      return new Response(JSON.stringify({ id: 'agent_1', name: 'Assistant' }), { status: 201 });
    });
    const client = new HttpClient('http://localhost:4000', fetchImpl);

    const result = await client.request<{ id: string; name: string }>('POST', '/api/v1/agents', { name: 'Assistant' });

    expect(result).toEqual({ id: 'agent_1', name: 'Assistant' });
  });

  it('attaches a bearer token once one is set', async () => {
    const fetchImpl = fakeFetch((_url, init) => {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok_123');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new HttpClient('http://localhost:4000', fetchImpl);
    client.setToken('tok_123');

    await client.request('GET', '/api/v1/auth/me');
  });

  it('sends no authorization header when no token is set', async () => {
    const fetchImpl = fakeFetch((_url, init) => {
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new HttpClient('http://localhost:4000', fetchImpl);

    await client.request('GET', '/api/v1/health');
  });

  it('joins request paths without a duplicate slash when baseUrl ends in a slash', async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe('http://localhost:4000/api/v1/health');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new HttpClient('http://localhost:4000/', fetchImpl);

    await client.request('GET', '/api/v1/health');
  });

  it('tolerates an empty response body (204 No Content)', async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 204 }));
    const client = new HttpClient('http://localhost:4000', fetchImpl);

    const result = await client.request<void>('DELETE', '/api/v1/conversations/c1/members/u1');

    expect(result).toBeUndefined();
  });

  it('throws CrewlyApiError with the status and server error code on a non-2xx response', async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ error: 'not_a_participant' }), { status: 403 })
    );
    const client = new HttpClient('http://localhost:4000', fetchImpl);

    await expect(client.request('GET', '/api/v1/conversations/c1/messages')).rejects.toMatchObject({
      status: 403,
      code: 'not_a_participant',
    });
  });

  it('uses the message the server sent, so the UI can show it as-is', async () => {
    const fetchImpl = fakeFetch(
      () => new Response(
        JSON.stringify({ error: 'provider_unavailable', message: 'Maya could not reply: the model provider could not be reached.' }),
        { status: 502 }
      )
    );
    const client = new HttpClient('http://localhost:4000', fetchImpl);

    await expect(client.request('POST', '/api/v1/agents/a1/runs')).rejects.toThrow(
      'Maya could not reply: the model provider could not be reached.'
    );
  });

  it('explains a bare error code rather than reporting the status line', async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ error: 'provider_not_configured' }), { status: 409 })
    );
    const client = new HttpClient('http://localhost:4000', fetchImpl);

    // Callers render error.message; "request failed with status 409" is not
    // something a person can act on.
    const error: CrewlyApiError = await client
      .request('POST', '/api/v1/agents')
      .then(() => { throw new Error('expected a rejection'); })
      .catch((e: unknown) => e as CrewlyApiError);
    expect(error.message).toContain('No model provider is configured');
    expect(error.message).not.toContain('409');
    expect(error.code).toBe('provider_not_configured');
  });

  it('wraps a fetch-level failure as a status-0 network_error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new HttpClient('http://localhost:4000', fetchImpl);

    await expect(client.request('GET', '/api/v1/health')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });

  it('rejects with a plain CrewlyApiError instance, not a generic Error, on failure', async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    const client = new HttpClient('http://localhost:4000', fetchImpl);

    try {
      await client.request('GET', '/api/v1/health');
      expect.fail('expected request to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CrewlyApiError);
    }
  });

  it('wraps a malformed JSON response as invalid_response with its HTTP status and raw body', async () => {
    const fetchImpl = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const client = new HttpClient('http://localhost:4000', fetchImpl);

    await expect(client.request('GET', '/api/v1/providers/p1/models')).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
      body: '<html>bad gateway</html>',
    });
  });

  it('wraps a response body read failure as invalid_response with its HTTP status', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('stream aborted');
      },
    })) as unknown as typeof fetch;
    const client = new HttpClient('http://localhost:4000', fetchImpl);

    await expect(client.request('GET', '/api/v1/health')).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    });
  });
});
