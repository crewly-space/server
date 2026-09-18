import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http-client.js';
import { DevicesResource } from './devices.js';

describe('DevicesResource', () => {
  it('lists devices and resolves and approves an encoded pairing code', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ method: init?.method ?? 'GET', path });
      return new Response(JSON.stringify(path === '/api/v1/devices' ? [] : {
        status: 'approved', deviceId: 'dev_abc', deviceName: 'Laptop', platform: null, expiresAt: '2099-01-01T00:00:00.000Z',
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const devices = new DevicesResource(new HttpClient('https://example.test', fetchImpl));
    await devices.list();
    await devices.pairingByCode('AB CD');
    await devices.approvePairing('AB CD');
    expect(calls).toEqual([
      { method: 'GET', path: '/api/v1/devices' },
      { method: 'GET', path: '/api/v1/devices/pairings/code/AB%20CD' },
      { method: 'POST', path: '/api/v1/devices/pairings/code/AB%20CD/approve' },
    ]);
  });
});
