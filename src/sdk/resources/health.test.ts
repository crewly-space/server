import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { HealthResource } from './health.js';

describe('HealthResource', () => {
  it('gets /api/v1/health and returns the server status', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:4000/api/v1/health');
      expect(init?.method).toBe('GET');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const health = new HealthResource(new HttpClient('http://localhost:4000', fetchImpl));

    await expect(health.get()).resolves.toEqual({ ok: true });
  });
});
