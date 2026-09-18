import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { AgentsResource } from './agents.js';

function clientWithFetch(handler: (method: string, path: string, body: unknown) => Response): HttpClient {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(init?.method ?? 'GET', path, body);
  }) as unknown as typeof fetch;
  return new HttpClient('http://localhost:4000', fetchImpl);
}

const AGENT_FIXTURE = {
  id: 'agent_1',
  ownerUserId: 'u1',
  name: 'Assistant',
  personality: '',
  modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
  permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
  relationships: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('AgentsResource', () => {
  it('create posts to /api/v1/agents with the model policy', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/agents');
      expect(body).toEqual({ name: 'Assistant', modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' } });
      return new Response(JSON.stringify(AGENT_FIXTURE), { status: 201 });
    });
    const agents = new AgentsResource(http);

    const agent = await agents.create({ name: 'Assistant', modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' } });

    expect(agent.id).toBe('agent_1');
  });

  it('list gets /api/v1/agents', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/agents');
      return new Response(JSON.stringify([AGENT_FIXTURE]), { status: 200 });
    });
    const agents = new AgentsResource(http);

    const list = await agents.list();

    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Assistant');
  });
});
