import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import type { DeviceConnectionHub } from './hub.js';
import { getDevice, getPairing, getPairingByCode, listDevicesForUser, type DeviceRecord } from './repository.js';

const PAIRING_TTL_MS = 10 * 60_000;
const CreatePairingSchema = z.object({
  deviceId: z.string().regex(/^dev_[0-9a-f]{20}$/),
  deviceName: z.string().min(1).max(100),
  publicKey: z.string().min(40).max(64),
  platform: z.string().min(1).max(100).optional(),
});
const ClaimPairingSchema = z.object({ pollToken: z.string().min(32).max(256) });

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const rawBase64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
const publicKeyBytes = (value: string): Buffer => Buffer.from(value, 'base64');
const deviceIdFor = (key: Buffer): string => `dev_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;

function publicDevice(device: DeviceRecord, hub: DeviceConnectionHub) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    capabilities: JSON.parse(device.capabilities),
    connected: hub.isConnected(device.id),
    lastSeenAt: device.last_seen_at,
    createdAt: device.created_at,
  };
}

function expired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() <= Date.now();
}

export function registerDeviceRoutes(app: FastifyInstance, hub: DeviceConnectionHub): void {
  const pairingWindows = new Map<string, { count: number; resetAt: number }>();
  app.post('/api/v1/devices/pairings', async (request, reply) => {
    const nowMs = Date.now();
    if (pairingWindows.size > 1024) {
      for (const [address, candidate] of pairingWindows) {
        if (candidate.resetAt <= nowMs) pairingWindows.delete(address);
      }
    }
    const current = pairingWindows.get(request.ip);
    const window = !current || current.resetAt <= nowMs
      ? { count: 1, resetAt: nowMs + 15 * 60_000 }
      : { count: current.count + 1, resetAt: current.resetAt };
    pairingWindows.set(request.ip, window);
    if (window.count > 20) {
      reply.code(429).send({ error: 'too_many_pairing_attempts' });
      return;
    }
    const body = CreatePairingSchema.parse(request.body);
    const publicKey = publicKeyBytes(body.publicKey);
    if (publicKey.length !== 32 || deviceIdFor(publicKey) !== body.deviceId) {
      reply.code(400).send({ error: 'invalid_device_identity' });
      return;
    }
    const now = new Date();
    const id = randomUUID();
    const pollToken = rawBase64(randomBytes(32));
    const userCode = randomBytes(4).toString('hex').toUpperCase();
    app.db.prepare('DELETE FROM device_pairings WHERE expires_at <= ? OR device_id = ?').run(now.toISOString(), body.deviceId);
    app.db.prepare(
      `INSERT INTO device_pairings
       (id, poll_token_hash, user_code, device_id, device_name, public_key, platform, expires_at, approved_by, approved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
    ).run(id, digest(pollToken), userCode, body.deviceId, body.deviceName.trim(), body.publicKey, body.platform ?? null,
      new Date(now.getTime() + PAIRING_TTL_MS).toISOString(), now.toISOString());
    reply.code(201).send({
      pairingId: id,
      pollToken,
      userCode,
      verificationUrl: `${request.protocol}://${request.headers.host ?? request.hostname}/?pair=${userCode}`,
      expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
    });
  });

  app.get('/api/v1/devices/pairings/code/:code', { preHandler: requireAuth }, async (request, reply) => {
    const code = (request.params as { code: string }).code.toUpperCase();
    const pairing = getPairingByCode(app.db, code);
    if (!pairing || expired(pairing.expires_at)) {
      reply.code(404).send({ error: 'pairing_not_found' });
      return;
    }
    reply.send({ deviceId: pairing.device_id, deviceName: pairing.device_name, platform: pairing.platform, expiresAt: pairing.expires_at });
  });

  app.post('/api/v1/devices/pairings/code/:code/approve', { preHandler: requireAuth }, async (request, reply) => {
    const code = (request.params as { code: string }).code.toUpperCase();
    const pairing = getPairingByCode(app.db, code);
    if (!pairing || expired(pairing.expires_at)) {
      reply.code(404).send({ error: 'pairing_not_found' });
      return;
    }
    if (pairing.approved_by && pairing.approved_by !== request.user!.id) {
      reply.code(409).send({ error: 'pairing_already_approved' });
      return;
    }
    const existing = getDevice(app.db, pairing.device_id);
    if (existing && existing.owner_user_id !== request.user!.id) {
      reply.code(409).send({ error: 'device_belongs_to_another_user' });
      return;
    }
    const now = new Date().toISOString();
    app.db.prepare(
      `INSERT INTO devices (id, owner_user_id, name, public_key, platform, capabilities, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET owner_user_id = excluded.owner_user_id, name = excluded.name,
         public_key = excluded.public_key, platform = excluded.platform, updated_at = excluded.updated_at`
    ).run(pairing.device_id, request.user!.id, pairing.device_name, pairing.public_key, pairing.platform, now, now);
    app.db.prepare('UPDATE device_pairings SET approved_by = ?, approved_at = ? WHERE id = ?')
      .run(request.user!.id, now, pairing.id);
    reply.send({ status: 'approved', deviceId: pairing.device_id });
  });

  app.post('/api/v1/devices/pairings/:id/claim', async (request, reply) => {
    const pairing = getPairing(app.db, (request.params as { id: string }).id);
    const body = ClaimPairingSchema.parse(request.body);
    if (!pairing || digest(body.pollToken) !== pairing.poll_token_hash || expired(pairing.expires_at)) {
      reply.code(404).send({ error: 'pairing_not_found' });
      return;
    }
    if (!pairing.approved_by) {
      reply.code(202).send({ status: 'pending' });
      return;
    }
    app.db.prepare('DELETE FROM device_pairings WHERE id = ?').run(pairing.id);
    reply.send({ status: 'approved', deviceId: pairing.device_id });
  });

  app.get('/api/v1/devices', { preHandler: requireAuth }, async (request, reply) => {
    reply.send(listDevicesForUser(app.db, request.user!.id).map((device) => publicDevice(device, hub)));
  });
}
