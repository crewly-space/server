import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { DeviceCapabilityError, DeviceConnectionHub, DeviceRequestError, DeviceUnavailableError } from './hub.js';

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

  it('does not send optional requests to a client that did not negotiate them', () => {
    const hub = new DeviceConnectionHub();
    const ws = socket();
    hub.connect('dev_1', ws as unknown as WebSocket);
    expect(() => hub.request('dev_1', 'provider.enable', { kind: 'ollama' }, 1_000, {
      requiredCapability: 'agentd.capabilities.v1',
    })).toThrow(DeviceCapabilityError);
    expect(ws.sent).toHaveLength(0);
  });

  it('sends optional requests after the client negotiates the capability', async () => {
    const hub = new DeviceConnectionHub();
    const ws = socket();
    hub.connect('dev_1', ws as unknown as WebSocket, ['agentd.capabilities.v1']);
    const pending = hub.request('dev_1', 'provider.enable', { kind: 'ollama' }, 1_000, {
      requiredCapability: 'agentd.capabilities.v1',
    });
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ operation: 'provider.enable' });
    hub.disconnect('dev_1', ws as unknown as WebSocket);
    await expect(pending).rejects.toThrow('disconnected');
  });
});
