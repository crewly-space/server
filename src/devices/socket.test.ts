import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
  });
}

describe('signed device socket', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let socket: WebSocket | undefined;
  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db });
    await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterEach(async () => {
    socket?.close();
    await app.close();
    // The server-side close handler publishes to the event log; let it land
    // before the database it writes to goes away.
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.close();
  });

  async function pairDevice() {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: {
      email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1',
    } });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const deviceId = `dev_${createHash('sha256').update(raw).digest('hex').slice(0, 20)}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO devices
      (id, owner_user_id, name, public_key, platform, capabilities, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '{}', NULL, ?, ?)`).run(
      deviceId, setup.json().user.id, 'Workstation', raw.toString('base64').replace(/=+$/, ''), 'test', now, now,
    );
    return {
      token: setup.json().token as string,
      ownerId: setup.json().user.id as string,
      deviceId,
      privateKey,
    };
  }

  async function authenticate(deviceId: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    const connected = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/agentd/connect`);
    const challenge = await nextMessage(connected);
    const timestamp = new Date().toISOString();
    const payload = Buffer.from(`${deviceId}\n${timestamp}\n${challenge.nonce}`, 'utf8');
    const signature = sign(null, payload, privateKey).toString('base64').replace(/=+$/, '');
    connected.send(JSON.stringify({ type: 'authenticate', deviceId, timestamp, nonce: challenge.nonce, signature }));
    expect(await nextMessage(connected)).toEqual({ type: 'authenticated', deviceId });
    return connected;
  }

  /** Events the owner's browser session would receive, oldest first. */
  function ownerEvents(ownerId: string): { type: string; payload: Record<string, unknown> }[] {
    const rows = db
      .prepare('SELECT type, payload FROM event_log WHERE topic = ? ORDER BY seq ASC')
      .all(`user:${ownerId}`) as { type: string; payload: string }[];
    return rows.map((row) => ({ type: row.type, payload: JSON.parse(row.payload) }));
  }

  async function waitForEvents(ownerId: string, count: number) {
    for (let i = 0; i < 50 && ownerEvents(ownerId).length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return ownerEvents(ownerId);
  }

  it('authenticates a paired Ed25519 identity and records heartbeat capabilities', async () => {
    const { token, deviceId, privateKey } = await pairDevice();
    socket = await authenticate(deviceId, privateKey);
    socket.send(JSON.stringify({ type: 'heartbeat', capabilities: { providers: [{ kind: 'ollama' }] } }));
    expect(await nextMessage(socket)).toMatchObject({ type: 'heartbeat.ack' });

    const pending = app.deviceHub.request(deviceId, 'provider.models', { kind: 'ollama', providerId: 'local' });
    const outbound = await nextMessage(socket);
    expect(outbound).toMatchObject({ operation: 'provider.models', payload: { kind: 'ollama' } });
    socket.send(JSON.stringify({ requestId: outbound.requestId, ok: true, result: { models: [] } }));
    await expect(pending).resolves.toEqual({ models: [] });

    const devices = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: { authorization: `Bearer ${token}` } });
    expect(devices.json()[0]).toMatchObject({ id: deviceId, connected: true, capabilities: { providers: [{ kind: 'ollama' }] } });
  });
  it('tells the owner when a device comes online and when it goes offline', async () => {
    const { ownerId, deviceId, privateKey } = await pairDevice();
    socket = await authenticate(deviceId, privateKey);

    expect(await waitForEvents(ownerId, 1)).toMatchObject([
      { type: 'device.connected', payload: { deviceId, name: 'Workstation', platform: 'test' } },
    ]);

    socket.close();
    socket = undefined;
    const events = await waitForEvents(ownerId, 2);
    expect(events[1]).toMatchObject({ type: 'device.disconnected', payload: { deviceId } });
  });
});
