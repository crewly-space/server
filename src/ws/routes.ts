import type { FastifyInstance } from 'fastify';
import { verifySessionToken } from '../auth/session.js';
import { listConversationsForParticipant } from '../conversations/repository.js';
import type { ConnectionHub } from './hub.js';
import { AGENT_STATUS_TOPIC } from '../agents/status.js';

export function registerWsRoutes(
  app: FastifyInstance,
  hub: ConnectionHub,
  // Same list the HTTP API uses. A socket carries no Origin check of its own,
  // so a server that allows no cross-origin caller must refuse one here too.
  trustedAppOrigins: string[] = [],
): void {
  app.get('/api/v1/ws', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !trustedAppOrigins.includes(origin) && origin !== `${request.protocol}://${request.headers.host}`) {
      socket.close(4003, 'forbidden_origin');
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const userId = verifySessionToken(app.db, token);
    if (!userId) {
      socket.close(4001, 'unauthorized');
      return;
    }

    const conversationTopics = listConversationsForParticipant(app.db, userId).map(
      (c) => `conversation:${c.id}`
    );
    // Agent status is server-wide: everyone sees the same canonical state.
    const topics = [`user:${userId}`, AGENT_STATUS_TOPIC, ...conversationTopics];
    hub.subscribe(socket, topics);

    const sinceSeqParam = url.searchParams.get('sinceSeq');
    if (sinceSeqParam !== null) {
      const missed = hub.replaySince(topics, Number(sinceSeqParam));
      for (const event of missed) {
        socket.send(JSON.stringify(event));
      }
    }

    socket.on('close', () => hub.unsubscribe(socket));
  });
}
