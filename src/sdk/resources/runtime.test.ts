import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { RuntimeResource } from './runtime.js';

function clientWithFetch(handler: (method: string, path: string, body: unknown) => Response): HttpClient {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(init?.method ?? 'GET', path, body);
  }) as unknown as typeof fetch;
  return new HttpClient('http://localhost:4000', fetchImpl);
}

const BINDING_FIXTURE = {
  id: 'binding_1',
  agentId: 'agent_1',
  runtimeKind: 'native',
  workspacePath: '/workspaces/assistant',
  vendorState: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SESSION_FIXTURE = {
  id: 'session_1',
  agentId: 'agent_1',
  conversationId: 'conv_1',
  runtimeBindingId: 'binding_1',
  status: 'idle',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const RUN_OUTCOME_FIXTURE = {
  run: {
    runId: 'run_1',
    rootRunId: 'run_1',
    causationId: null,
    hopCount: 0,
    agentId: 'agent_1',
    conversationId: 'conv_1',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  message: {
    id: 'msg_1',
    conversationId: 'conv_1',
    authorId: 'agent_1',
    authorType: 'agent',
    body: 'Hello!',
    mentions: [],
    replyToMessageId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  handoff: { attempted: false, dispatched: false },
};

describe('RuntimeResource', () => {
  it('createBinding posts to /api/v1/runtime-bindings', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/runtime-bindings');
      expect(body).toEqual({ agentId: 'agent_1', runtimeKind: 'native', workspacePath: '/workspaces/assistant' });
      return new Response(JSON.stringify(BINDING_FIXTURE), { status: 201 });
    });
    const runtime = new RuntimeResource(http);

    const binding = await runtime.createBinding({ agentId: 'agent_1', runtimeKind: 'native', workspacePath: '/workspaces/assistant' });

    expect(binding.id).toBe('binding_1');
  });

  it('getBinding gets /api/v1/runtime-bindings/:id', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/runtime-bindings/binding_1');
      return new Response(JSON.stringify(BINDING_FIXTURE), { status: 200 });
    });
    const runtime = new RuntimeResource(http);

    const binding = await runtime.getBinding('binding_1');

    expect(binding.id).toBe('binding_1');
  });

  it('createSession posts to /api/v1/runtime-sessions', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/runtime-sessions');
      expect(body).toEqual({ agentId: 'agent_1', conversationId: 'conv_1', runtimeBindingId: 'binding_1' });
      return new Response(JSON.stringify(SESSION_FIXTURE), { status: 201 });
    });
    const runtime = new RuntimeResource(http);

    const session = await runtime.createSession({ agentId: 'agent_1', conversationId: 'conv_1', runtimeBindingId: 'binding_1' });

    expect(session.id).toBe('session_1');
  });

  it('getSession gets /api/v1/runtime-sessions/:id', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/runtime-sessions/session_1');
      return new Response(JSON.stringify(SESSION_FIXTURE), { status: 200 });
    });
    const runtime = new RuntimeResource(http);

    const session = await runtime.getSession('session_1');

    expect(session.status).toBe('idle');
  });

  it('invokeAgent posts to /api/v1/agents/:id/runs and returns the run outcome', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/agents/agent_1/runs');
      expect(body).toEqual({ conversationId: 'conv_1' });
      return new Response(JSON.stringify(RUN_OUTCOME_FIXTURE), { status: 201 });
    });
    const runtime = new RuntimeResource(http);

    const outcome = await runtime.invokeAgent('agent_1', { conversationId: 'conv_1' });

    expect(outcome.message.body).toBe('Hello!');
    expect(outcome.handoff.attempted).toBe(false);
  });
});
