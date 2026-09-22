import 'fastify';
import type { Database } from './db/driver.js';
import type { ConnectionHub } from './ws/hub.js';
import type { DeviceConnectionHub } from './devices/hub.js';
import type { AiGateway } from './gateway/gateway.js';
import type { AgentStatusBroadcaster } from './agents/status.js';
import type { AgentRunQueue } from './runtime/queue.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    hub: ConnectionHub;
    deviceHub: DeviceConnectionHub;
    gateway: AiGateway;
    agentStatus: AgentStatusBroadcaster;
    runQueue: AgentRunQueue;
  }
  interface FastifyRequest {
    user?: { id: string; role: string };
  }
}
