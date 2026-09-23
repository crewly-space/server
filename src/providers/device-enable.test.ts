import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { DeviceConnectionHub } from '../devices/hub.js';
import { getDevice } from '../devices/repository.js';
import { AgentdBackedProviderClient } from './agentd.js';
import { enableOnDevices } from './device-enable.js';
import { ProviderDeviceMissingError, ProviderRuntimeMissingError, ProviderSignInExpiredError } from './errors.js';

const DEVICE = 'dev_0123456789abcdef0123';
const OTHER = 'dev_ffffffffffffffffffff';

function setup(capabilities: Record<string, unknown> = {}) {
  const db = openSqlite(':memory:');
  runMigrations(db);
  const now = new Date().toISOString();
  const insertUser = db.prepare(`INSERT INTO users (id, email, display_name, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insertUser.run('owner-1', 'owner@example.test', 'Owner', 'hash', 'owner', now);
  insertUser.run('other-1', 'other@example.test', 'Other', 'hash', 'member', now);
  const insertDevice = db.prepare(`INSERT INTO devices
    (id, owner_user_id, name, public_key, platform, capabilities, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertDevice.run(DEVICE, 'owner-1', 'Laptop', 'key', 'test', JSON.stringify(capabilities), now, now, now);
  insertDevice.run(OTHER, 'other-1', 'Their laptop', 'key2', 'test', '{}', now, now, now);
  const hub = new DeviceConnectionHub();
  const sockets = new Map<string, { sent: string[] }>();
  for (const id of [DEVICE, OTHER]) {
    const socket = { OPEN: 1, readyState: 1, sent: [] as string[], send(value: string) { this.sent.push(value); }, close() {} };
    sockets.set(id, socket);
    hub.connect(id, socket as unknown as WebSocket);
  }
  return { db, hub, sockets };
}

/** Answers the next request a device received. */
async function answer(hub: DeviceConnectionHub, sockets: Map<string, { sent: string[] }>, deviceId: string,
  response: { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const outbound = JSON.parse(sockets.get(deviceId)!.sent.at(-1)!) as { requestId: string; operation: string; payload: unknown };
  hub.handleResponse(deviceId, { requestId: outbound.requestId, ...response });
  return outbound;
}

describe('enabling a device-backed provider', () => {
  it('asks only the requester’s own devices, and stores what the device now offers', async () => {
    const { db, hub, sockets } = setup();
    const pending = enableOnDevices(db, hub, 'owner-1', 'claude-subscription');
    const sent = await answer(hub, sockets, DEVICE, { ok: true, result: {
      enabled: true, capabilities: { providers: [{ kind: 'claude-subscription' }] },
    } });

    expect(sent).toMatchObject({ operation: 'provider.enable', payload: { kind: 'claude-subscription' } });
    expect(await pending).toEqual([{ deviceId: DEVICE, deviceName: 'Laptop', enabled: true }]);
    expect(sockets.get(OTHER)!.sent).toHaveLength(0);
    expect(JSON.parse(getDevice(db, DEVICE)!.capabilities)).toEqual({ providers: [{ kind: 'claude-subscription' }] });
    db.close();
  });

  it('reports why a device refused', async () => {
    const { db, hub, sockets } = setup();
    const pending = enableOnDevices(db, hub, 'owner-1', 'claude-subscription');
    await answer(hub, sockets, DEVICE, { ok: false, error: { code: 'provider_sign_in_expired', message: 'run claude login' } });
    expect(await pending).toEqual([{ deviceId: DEVICE, deviceName: 'Laptop', enabled: false, error: 'provider_sign_in_expired' }]);
    db.close();
  });

  it('leaves alone a device that already offers the provider', async () => {
    const { db, hub, sockets } = setup({ providers: [{ kind: 'claude-subscription' }] });
    expect(await enableOnDevices(db, hub, 'owner-1', 'claude-subscription')).toEqual([]);
    expect(sockets.get(DEVICE)!.sent).toHaveLength(0);
    db.close();
  });
});

describe('device provider failures', () => {
  function provider(db: Database, hub: DeviceConnectionHub) {
    return new AgentdBackedProviderClient('claude-subscription', 'local', 'owner-1', db, hub);
  }
  const chat = { providerId: 'local', model: 'claude', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('says when there is no device, without retrying', async () => {
    const { db, hub } = setup();
    const error = await provider(db, hub).chat(chat).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProviderDeviceMissingError);
    expect(error).toMatchObject({ code: 'provider_device_missing', retryable: false });
    db.close();
  });

  it('tells an expired sign-in apart from a missing runtime', async () => {
    const { db, hub, sockets } = setup({ providers: [{ kind: 'claude-subscription' }] });
    const expired = provider(db, hub).chat(chat);
    await answer(hub, sockets, DEVICE, { ok: false, error: { code: 'provider_sign_in_expired', message: 'run claude login' } });
    await expect(expired).rejects.toBeInstanceOf(ProviderSignInExpiredError);

    const missing = provider(db, hub).chat(chat);
    await answer(hub, sockets, DEVICE, { ok: false, error: { code: 'runtime_missing', message: 'Claude Code is not installed' } });
    await expect(missing).rejects.toBeInstanceOf(ProviderRuntimeMissingError);
    db.close();
  });
});
