import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { UsersResource } from './users.js';

describe('UsersResource', () => {
  it('lists and creates users', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(path.endsWith('/users') && init?.method === 'POST'
        ? JSON.stringify({ id: 'u2', email: 'member@example.com', displayName: 'Member', role: 'member', createdAt: 'now' })
        : JSON.stringify([]), { status: init?.method === 'POST' ? 201 : 200 });
    }) as unknown as typeof fetch;
    const users = new UsersResource(new HttpClient('https://example.test', fetchImpl));
    await users.list();
    await users.create({ email: 'member@example.com', displayName: 'Member', password: 'super-secret-1' });
    expect(calls).toEqual([
      { method: 'GET', path: '/api/v1/users', body: undefined },
      { method: 'POST', path: '/api/v1/users', body: { email: 'member@example.com', displayName: 'Member', password: 'super-secret-1' } },
    ]);
  });
});
