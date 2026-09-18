import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getConversation, isParticipant } from '../conversations/repository.js';
import { getAgent } from '../agents/repository.js';
import { getProviderConfig } from '../providers/repository.js';
import { runAgentTurn, type RespondFn } from '../runtime/engine.js';
import { enqueueJob } from '../jobs/repository.js';
import { SUMMARIZE_CONVERSATION_JOB_TYPE } from '../memory/summary.js';
import type { ConnectionHub } from '../ws/hub.js';
import { createMessage, listMessagesForConversation, ReplyNotInConversationError } from './repository.js';

const CreateMessageBodySchema = z.object({
  body: z.string().min(1),
  mentions: z
    .array(z.object({ targetId: z.string().min(1), targetType: z.enum(['user', 'agent']) }))
    .default([]),
  replyToMessageId: z.string().min(1).nullable().default(null),
});

const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export function registerMessageRoutes(app: FastifyInstance, hub: ConnectionHub, respond: RespondFn): void {
  app.post('/api/v1/conversations/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = getConversation(app.db, id);
    if (!conversation) {
      reply.code(404).send({ error: 'conversation_not_found' });
      return;
    }
    if (!isParticipant(app.db, id, request.user!.id, 'user')) {
      reply.code(403).send({ error: 'not_a_participant' });
      return;
    }
    const body = CreateMessageBodySchema.parse(request.body);
    const dmAgentId = conversation.kind === 'dm'
      ? conversation.participants.find((p) => p.participantType === 'agent')?.participantId
      : undefined;
    if (dmAgentId) {
      const agent = getAgent(app.db, dmAgentId);
      if (!agent || !getProviderConfig(app.db, agent.modelPolicy.defaultProviderId)) {
        reply.code(409).send({ error: 'provider_not_configured' });
        return;
      }
    }

    let message;
    try {
      message = createMessage(app.db, {
        conversationId: id,
        authorId: request.user!.id,
        authorType: 'user',
        body: body.body,
        mentions: body.mentions,
        replyToMessageId: body.replyToMessageId,
      });
    } catch (err) {
      if (err instanceof ReplyNotInConversationError) {
        reply.code(400).send({ error: 'invalid_reply' });
        return;
      }
      throw err;
    }

    hub.publish(`conversation:${id}`, 'message.created', { ...message });
    enqueueJob(app.db, {
      type: SUMMARIZE_CONVERSATION_JOB_TYPE,
      payload: { conversationId: id },
      dedupeKey: `${SUMMARIZE_CONVERSATION_JOB_TYPE}:${id}`,
    });
    reply.code(201).send(message);
    if (dmAgentId) {
      void runAgentTurn({ db: app.db, hub, respond }, { agentId: dmAgentId, conversationId: id })
        .catch((error: unknown) => {
          hub.publish(`user:${request.user!.id}`, 'agent.run.failed', {
            conversationId: id, messageId: message.id,
            error: error instanceof Error ? error.message : 'Agent response failed',
          });
        });
    }
  });

  app.get('/api/v1/conversations/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isParticipant(app.db, id, request.user!.id, 'user')) {
      reply.code(403).send({ error: 'not_a_participant' });
      return;
    }
    const query = ListMessagesQuerySchema.parse(request.query);
    reply.send(listMessagesForConversation(app.db, id, query.limit));
  });
}
