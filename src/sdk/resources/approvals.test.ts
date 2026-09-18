import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { ApprovalsResource } from './approvals.js';

function clientWithFetch(handler: (method: string, path: string, body: unknown) => Response): HttpClient {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(init?.method ?? 'GET', path, body);
  }) as unknown as typeof fetch;
  return new HttpClient('http://localhost:4000', fetchImpl);
}

const APPROVAL_FIXTURE = {
  id: 'approval_1',
  runId: 'run_1',
  agentId: 'agent_1',
  action: 'delete_file',
  details: { path: '/tmp/x' },
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  resolvedAt: null,
};

describe('ApprovalsResource', () => {
  it('list gets /api/v1/approvals', async () => {
    const http = clientWithFetch((method, path) => {
      expect(method).toBe('GET');
      expect(path).toBe('/api/v1/approvals');
      return new Response(JSON.stringify([APPROVAL_FIXTURE]), { status: 200 });
    });
    const approvals = new ApprovalsResource(http);

    const list = await approvals.list();

    expect(list).toHaveLength(1);
  });

  it('respond posts to /api/v1/approvals/:id/respond with the decision', async () => {
    const http = clientWithFetch((method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/v1/approvals/approval_1/respond');
      expect(body).toEqual({ decision: 'approve' });
      return new Response(JSON.stringify({ ...APPROVAL_FIXTURE, status: 'approved', resolvedAt: '2026-01-01T00:01:00.000Z' }), { status: 200 });
    });
    const approvals = new ApprovalsResource(http);

    const result = await approvals.respond('approval_1', 'approve');

    expect(result.status).toBe('approved');
  });
});
