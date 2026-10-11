import type { FastifyInstance } from 'fastify';
import { verifySessionToken } from '../auth/session.js';
import { listConversationsForParticipant } from '../conversations/repository.js';
import type { ConnectionHub } from './hub.js';
import { AGENT_STATUS_TOPIC } from '../agents/status.js';
import { CHANNELS_TOPIC } from '../channels/routes.js';
import { requireAuth } from '../auth/middleware.js';
import { getUserById } from '../users/repository.js';

export function registerWsRoutes(
  app: FastifyInstance,
  hub: ConnectionHub,
  // Same list the HTTP API uses. A socket carries no Origin check of its own,
  // so a server that allows no cross-origin caller must refuse one here too.
  trustedAppOrigins: string[] = [],
): void {
  app.get('/api/v1/ws/cursor', { preHandler: requireAuth }, async (_request, reply) => {
    const seq = app.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM event_log').pluck().get();
    reply.send({ seq: Number(seq) });
  });
  const sessionTimer = setInterval(() => hub.revalidateSessions(), 30_000);
  sessionTimer.unref?.();
  app.addHook('onClose', async () => clearInterval(sessionTimer));
  app.get('/api/v1/ws', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !trustedAppOrigins.includes(origin) && origin !== `${request.protocol}://${request.headers.host}`) {
      socket.close(4003, 'forbidden_origin');
      return;
    }
    let authenticated = false;
    const timer = setTimeout(() => socket.close(4001, 'authentication timed out'), 10_000);
    timer.unref?.();
    socket.on('message', (raw) => {
      if (authenticated) return;
      let message: { type?: unknown; token?: unknown; sinceSeq?: unknown };
      try { message = JSON.parse(raw.toString()) as typeof message; } catch { socket.close(4001, 'unauthorized'); return; }
      if (message.type !== 'authenticate' || typeof message.token !== 'string') { socket.close(4001, 'unauthorized'); return; }
      const userId = verifySessionToken(app.db, message.token);
      if (!userId) { socket.close(4001, 'unauthorized'); return; }
      const token = message.token;
      const authorize = () => {
        if (verifySessionToken(app.db, token) !== userId) return false;
        const user = getUserById(app.db, userId);
        return Boolean(user && !user.suspended_at);
      };
      if (!authorize()) { socket.close(4001, 'unauthorized'); return; }
      authenticated = true;
      clearTimeout(timer);
      const conversationTopics = listConversationsForParticipant(app.db, userId, { includeChannels: true }).map(
        (c) => `conversation:${c.id}`
      );
      const topics = [`user:${userId}`, AGENT_STATUS_TOPIC, CHANNELS_TOPIC, ...conversationTopics];
      hub.subscribe(socket, topics, userId, authorize);
      socket.send(JSON.stringify({ type: 'authenticated' }));
      if (typeof message.sinceSeq === 'number' && Number.isSafeInteger(message.sinceSeq) && message.sinceSeq >= 0) {
        for (const event of hub.replaySince(topics, message.sinceSeq)) socket.send(JSON.stringify(event));
      }
    });
    socket.on('close', () => { clearTimeout(timer); hub.unsubscribe(socket); });
  });
}
