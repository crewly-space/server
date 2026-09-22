import 'fastify';
import type { Database } from './db/driver.js';
import type { ConnectionHub } from './ws/hub.js';
import type { DeviceConnectionHub } from './devices/hub.js';
import type { AiGateway } from './gateway/gateway.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    hub: ConnectionHub;
    deviceHub: DeviceConnectionHub;
    gateway: AiGateway;
  }
  interface FastifyRequest {
    user?: { id: string; role: string };
  }
}
