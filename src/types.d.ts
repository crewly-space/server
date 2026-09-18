import 'fastify';
import type { Database } from './db/driver.js';
import type { ConnectionHub } from './ws/hub.js';
import type { DeviceConnectionHub } from './devices/hub.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    hub: ConnectionHub;
    deviceHub: DeviceConnectionHub;
  }
  interface FastifyRequest {
    user?: { id: string; role: string };
  }
}
