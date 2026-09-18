import { describe, expect, it, vi } from 'vitest';
import { OpenCrewClient } from './client.js';

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {})) as unknown as typeof fetch;
}

describe('OpenCrewClient', () => {
  it('exposes every resource wired to the same base URL', async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe('http://localhost:4000/api/v1/agents');
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const client = new OpenCrewClient({ baseUrl: 'http://localhost:4000', fetchImpl });

    await client.agents.list();
  });

  it('setToken applies to every resource sharing the underlying HttpClient', async () => {
    const fetchImpl = fakeFetch((_url, init) => {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok_1');
      return new Response(JSON.stringify({ id: 'u1', email: 'a@example.com', role: 'owner' }), { status: 200 });
    });
    const client = new OpenCrewClient({ baseUrl: 'http://localhost:4000', fetchImpl });
    client.setToken('tok_1');

    await client.auth.me();
  });

  it('ws() returns a fresh WsClient sharing the same base URL', () => {
    class FakeWebSocket {
      constructor(public url: string) {}
      close(): void {}
    }
    const client = new OpenCrewClient({ baseUrl: 'http://localhost:4000' });

    const ws = client.ws(FakeWebSocket);
    ws.connect({ token: 'tok_1' });

    expect(ws.getLastSeq()).toBeUndefined();
  });
});
