import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { DeviceConnectionHub, DeviceRequestError, DeviceUnavailableError } from './hub.js';

function socket() {
  return { OPEN: 1, readyState: 1, sent: [] as string[], send(value: string) { this.sent.push(value); }, close() {} };
}

describe('DeviceConnectionHub requests', () => {
  it('correlates a typed response with the device request', async () => {
    const hub = new DeviceConnectionHub();
    const ws = socket();
    hub.connect('dev_1', ws as unknown as WebSocket);
    const pending = hub.request('dev_1', 'provider.models', { kind: 'ollama' });
    const sent = JSON.parse(ws.sent[0]!) as { requestId: string };
    expect(hub.handleResponse('dev_1', { requestId: sent.requestId, ok: true, result: { models: ['qwen'] } })).toBe(true);
    await expect(pending).resolves.toEqual({ models: ['qwen'] });
  });

  it('rejects device errors and disconnected devices', async () => {
    const hub = new DeviceConnectionHub();
    expect(() => hub.request('missing', 'provider.models', {})).toThrow(DeviceUnavailableError);
    const ws = socket();
    hub.connect('dev_1', ws as unknown as WebSocket);
    const failed = hub.request('dev_1', 'provider.chat', {});
    const sent = JSON.parse(ws.sent[0]!) as { requestId: string };
    hub.handleResponse('dev_1', { requestId: sent.requestId, ok: false, error: { code: 'provider_unavailable', message: 'not installed' } });
    await expect(failed).rejects.toBeInstanceOf(DeviceRequestError);
    const disconnected = hub.request('dev_1', 'provider.models', {});
    hub.disconnect('dev_1', ws as unknown as WebSocket);
    await expect(disconnected).rejects.toThrow('disconnected');
  });
});
