import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { MemoryResource } from './memory.js';

function clientWithFetch(handler: (method: string, path: string, body: unknown) => Response): HttpClient {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(init?.method ?? 'GET', path, body);
  }) as unknown as typeof fetch;
  return new HttpClient('http://localhost:4000', fetchImpl);
}

const FACT_FIXTURE = {
  id: 'fact_1',
  agentId: 'agent_1',
  content: 'Prefers concise answers.',
  source: 'manual',
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('MemoryResource', () => {
  it('createFact posts to /api/v1/agents/:agentId/memory-facts', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/agents/agent_1/memory-facts');
      expect(body).toEqual({ content: 'Prefers concise answers.' });
      return new Response(JSON.stringify(FACT_FIXTURE), { status: 201 });
    });
    const memory = new MemoryResource(http);

    const fact = await memory.createFact('agent_1', { content: 'Prefers concise answers.' });

    expect(fact.id).toBe('fact_1');
  });

  it('listFacts gets /api/v1/agents/:agentId/memory-facts', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/agents/agent_1/memory-facts');
      return new Response(JSON.stringify([FACT_FIXTURE]), { status: 200 });
    });
    const memory = new MemoryResource(http);

    const list = await memory.listFacts('agent_1');

    expect(list).toHaveLength(1);
  });

  it('updateFact patches /api/v1/agents/:agentId/memory-facts/:factId', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('PATCH');
      expect(path).toBe('/api/v1/agents/agent_1/memory-facts/fact_1');
      expect(body).toEqual({ content: 'Revised.' });
      return new Response(JSON.stringify({ ...FACT_FIXTURE, content: 'Revised.' }), { status: 200 });
    });
    const memory = new MemoryResource(http);

    const fact = await memory.updateFact('agent_1', 'fact_1', { content: 'Revised.' });

    expect(fact.content).toBe('Revised.');
  });

  it('deleteFact deletes /api/v1/agents/:agentId/memory-facts/:factId', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('DELETE');
      expect(path).toBe('/api/v1/agents/agent_1/memory-facts/fact_1');
      return new Response(null, { status: 204 });
    });
    const memory = new MemoryResource(http);

    await expect(memory.deleteFact('agent_1', 'fact_1')).resolves.toBeUndefined();
  });

  it('getConversationSummary gets /api/v1/conversations/:id/summary', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/conversations/conv_1/summary');
      return new Response(
        JSON.stringify({ conversationId: 'conv_1', summary: 'recap', upToMessageId: 'msg_1', updatedAt: '2026-01-01T00:00:00.000Z' }),
        { status: 200 }
      );
    });
    const memory = new MemoryResource(http);

    const summary = await memory.getConversationSummary('conv_1');

    expect(summary.summary).toBe('recap');
  });

  it('getConversationSummary rejects with a 404 CrewlyApiError when no summary exists yet', async () => {
    const http = clientWithFetch(() => new Response(JSON.stringify({ error: 'summary_not_found' }), { status: 404 }));
    const memory = new MemoryResource(http);

    await expect(memory.getConversationSummary('conv_1')).rejects.toMatchObject({ status: 404 });
  });
});
