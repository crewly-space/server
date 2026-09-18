import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';

function identity() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    deviceId: `dev_${createHash('sha256').update(raw).digest('hex').slice(0, 20)}`,
    publicKey: raw.toString('base64').replace(/=+$/, ''),
  };
}

describe('device pairing routes', () => {
  let db: Database;
  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  async function ownerToken(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    return setup.json().token as string;
  }

  it('pairs a device through a short user code and exposes no polling secret to the user session', async () => {
    const app = await buildApp({ db });
    const token = await ownerToken(app);
    const id = identity();
    const created = await app.inject({
      method: 'POST', url: '/api/v1/devices/pairings',
      payload: { ...id, deviceName: 'Workstation', platform: 'windows/x64' },
    });
    expect(created.statusCode).toBe(201);
    const pairing = created.json();
    expect(pairing.userCode).toMatch(/^[A-F0-9]{8}$/);
    expect(pairing.pollToken).toBeTypeOf('string');

    const details = await app.inject({
      method: 'GET', url: `/api/v1/devices/pairings/code/${pairing.userCode}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(details.json()).toMatchObject({ deviceId: id.deviceId, deviceName: 'Workstation', platform: 'windows/x64' });
    expect(details.body).not.toContain(pairing.pollToken);

    const pending = await app.inject({
      method: 'POST', url: `/api/v1/devices/pairings/${pairing.pairingId}/claim`,
      payload: { pollToken: pairing.pollToken },
    });
    expect(pending.statusCode).toBe(202);

    const approved = await app.inject({
      method: 'POST', url: `/api/v1/devices/pairings/code/${pairing.userCode}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(approved.json()).toEqual({ status: 'approved', deviceId: id.deviceId });

    const claimed = await app.inject({
      method: 'POST', url: `/api/v1/devices/pairings/${pairing.pairingId}/claim`,
      payload: { pollToken: pairing.pollToken },
    });
    expect(claimed.json()).toEqual({ status: 'approved', deviceId: id.deviceId });
    const replay = await app.inject({
      method: 'POST', url: `/api/v1/devices/pairings/${pairing.pairingId}/claim`,
      payload: { pollToken: pairing.pollToken },
    });
    expect(replay.statusCode).toBe(404);

    const devices = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: { authorization: `Bearer ${token}` } });
    expect(devices.json()).toEqual([expect.objectContaining({ id: id.deviceId, name: 'Workstation', connected: false })]);
    expect(devices.body).not.toContain(id.publicKey);
    await app.close();
  });

  it('rejects a public key that does not derive the claimed device id', async () => {
    const app = await buildApp({ db });
    const id = identity();
    const response = await app.inject({
      method: 'POST', url: '/api/v1/devices/pairings',
      payload: { ...id, deviceId: 'dev_00000000000000000000', deviceName: 'Impostor' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_device_identity' });
    await app.close();
  });
});
