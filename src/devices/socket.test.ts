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
    db.close();
  });

  it('authenticates a paired Ed25519 identity and records heartbeat capabilities', async () => {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: {
      email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1',
    } });
    const token = setup.json().token as string;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const deviceId = `dev_${createHash('sha256').update(raw).digest('hex').slice(0, 20)}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO devices
      (id, owner_user_id, name, public_key, platform, capabilities, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '{}', NULL, ?, ?)`).run(
      deviceId, setup.json().user.id, 'Workstation', raw.toString('base64').replace(/=+$/, ''), 'test', now, now,
    );
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/agentd/connect`);
    const challenge = await nextMessage(socket);
    const timestamp = new Date().toISOString();
    const payload = Buffer.from(`${deviceId}\n${timestamp}\n${challenge.nonce}`, 'utf8');
    const signature = sign(null, payload, privateKey).toString('base64').replace(/=+$/, '');
    socket.send(JSON.stringify({ type: 'authenticate', deviceId, timestamp, nonce: challenge.nonce, signature }));
    expect(await nextMessage(socket)).toEqual({ type: 'authenticated', deviceId });
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
});
