import type { FastifyInstance } from 'fastify';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  AgentdAuthenticateSchema,
  AgentdHeartbeatSchema,
  AgentdResponseSchema,
  negotiateProtocol,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
} from '../protocol/index.js';
import type { DeviceConnectionHub } from './hub.js';
import type { ConnectionHub } from '../ws/hub.js';
import { getDevice, touchDevice } from './repository.js';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const AUTH_WINDOW_MS = 60_000;

function signaturePayload(deviceId: string, timestamp: string, nonce: string): Buffer {
  return Buffer.from(`${deviceId}\n${timestamp}\n${nonce}`, 'utf8');
}

export function registerDeviceSocket(
  app: FastifyInstance,
  hub: DeviceConnectionHub,
  events?: ConnectionHub,
  options: { version?: string } = {}
): void {
  app.get('/api/v1/agentd/connect', { websocket: true }, (socket) => {
    const nonce = randomBytes(24).toString('base64url');
    let authenticatedDeviceId: string | undefined;
    let ownerUserId: string | undefined;
    const authTimer = setTimeout(() => socket.close(4001, 'authentication timed out'), 15_000);
    authTimer.unref?.();
    socket.send(JSON.stringify({ type: 'challenge', nonce }));

    socket.on('message', (raw) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString());
      } catch {
        socket.close(4002, 'invalid JSON');
        return;
      }

      if (!authenticatedDeviceId) {
        const parsed = AgentdAuthenticateSchema.safeParse(decoded);
        if (!parsed.success || parsed.data.nonce !== nonce) {
          socket.close(4001, 'invalid authentication');
          return;
        }
        const timestamp = new Date(parsed.data.timestamp).getTime();
        if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > AUTH_WINDOW_MS) {
          socket.close(4001, 'stale authentication');
          return;
        }
        const device = getDevice(app.db, parsed.data.deviceId);
        if (!device || !validSignature(device.public_key, parsed.data.signature,
          signaturePayload(parsed.data.deviceId, parsed.data.timestamp, nonce))) {
          socket.close(4001, 'invalid authentication');
          return;
        }
        const negotiation = negotiateProtocol(parsed.data.protocolVersion);
        if (!negotiation.compatible) {
          socket.send(JSON.stringify({
            type: 'protocol.error',
            code: 'protocol_incompatible',
            message: `This server speaks protocol ${PROTOCOL_VERSION}; update the connected Crewly client.`,
            serverVersion: options.version ?? '0.0.0-dev',
            protocolVersion: PROTOCOL_VERSION,
          }));
          socket.close(4003, 'protocol incompatible');
          return;
        }
        authenticatedDeviceId = device.id;
        ownerUserId = device.owner_user_id;
        clearTimeout(authTimer);
        hub.connect(device.id, socket as WebSocket);
        touchDevice(app.db, device.id);
        events?.publish(`user:${device.owner_user_id}`, 'device.connected', {
          deviceId: device.id,
          name: device.name,
          platform: device.platform,
        });
        socket.send(JSON.stringify({
          type: 'authenticated',
          deviceId: device.id,
          serverVersion: options.version ?? '0.0.0-dev',
          protocolVersion: PROTOCOL_VERSION,
          capabilities: PROTOCOL_CAPABILITIES,
          compatibility: negotiation.reason,
        }));
        app.agentStatus.refresh();
        return;
      }

      const heartbeat = AgentdHeartbeatSchema.safeParse(decoded);
      if (heartbeat.success) {
        const capabilities = {
          ...(heartbeat.data.capabilities ?? {}),
          ...(heartbeat.data.protocolVersion ? { protocolVersion: heartbeat.data.protocolVersion } : {}),
          ...(heartbeat.data.clientVersion ? { clientVersion: heartbeat.data.clientVersion } : {}),
        };
        touchDevice(app.db, authenticatedDeviceId, capabilities);
        // A heartbeat can say a runtime was installed or signed out.
        app.agentStatus.refresh();
        socket.send(JSON.stringify({ type: 'heartbeat.ack', at: new Date().toISOString() }));
        return;
      }
      const response = AgentdResponseSchema.safeParse(decoded);
      if (response.success) hub.handleResponse(authenticatedDeviceId, response.data);
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (!authenticatedDeviceId) return;
      // A replaced connection leaves the device online under the newer socket,
      // which already owns the hub entry — only the live socket announces going
      // offline, so a reconnect does not look like a disconnect.
      const wasLive = hub.disconnect(authenticatedDeviceId, socket as WebSocket);
      if (wasLive) app.agentStatus.refresh();
      if (wasLive && ownerUserId) {
        events?.publish(`user:${ownerUserId}`, 'device.disconnected', { deviceId: authenticatedDeviceId });
      }
    });
  });
}

function validSignature(publicKey: string, signature: string, payload: Buffer): boolean {
  try {
    const rawKey = Buffer.from(publicKey, 'base64');
    if (rawKey.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, rawKey]), format: 'der', type: 'spki' });
    return verify(null, payload, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
