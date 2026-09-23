import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getConversation, isParticipant } from '../conversations/repository.js';
import { getAgent } from '../agents/repository.js';
import { getProviderConfig } from '../providers/repository.js';
import { describeAgentFailure } from '../providers/errors.js';
import { runAgentTurn, runIdOfFailure, type RespondFn } from '../runtime/engine.js';
import { enqueueJob } from '../jobs/repository.js';
import { SUMMARIZE_CONVERSATION_JOB_TYPE } from '../memory/summary.js';
import type { ConnectionHub } from '../ws/hub.js';
import { emitNotification } from '../notifications/service.js';
import { getUserById, type Role } from '../users/repository.js';
import { canReadChannel, getChannel } from '../channels/repository.js';
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

type MentionRef = { targetId: string; targetType: 'user' | 'agent' };

/** Agents mentioned in the message that actually belong to the conversation. */
function mentionedAgentIds(
  conversation: { participants: { participantId: string; participantType: string }[] },
  mentions: MentionRef[]
): string[] {
  const members = new Set(
    conversation.participants.filter((p) => p.participantType === 'agent').map((p) => p.participantId)
  );
  return [
    ...new Set(
      mentions.filter((m) => m.targetType === 'agent' && members.has(m.targetId)).map((m) => m.targetId)
    ),
  ];
}

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
    if (conversation.kind === 'channel') {
      const channel = getChannel(app.db, id, { id: request.user!.id, role: request.user!.role as Role });
      if (channel?.archivedAt) {
        reply.code(409).send({ error: 'channel_archived' });
        return;
      }
      if (!channel?.canPost) {
        reply.code(403).send({ error: 'channel_post_restricted' });
        return;
      }
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

    // People told about this message: whoever it mentions, and the other person in a DM.
    const author = getUserById(app.db, request.user!.id)?.display_name ?? 'Someone';
    const preview = body.body.length > 280 ? `${body.body.slice(0, 277)}...` : body.body;
    const mentioned = [...new Set(body.mentions
      .filter((mention) => mention.targetType === 'user' && mention.targetId !== request.user!.id && isParticipant(app.db, id, mention.targetId, 'user'))
      .map((mention) => mention.targetId))];
    void emitNotification(app.db, {
      type: 'mention.created',
      recipients: mentioned.map((userId) => ({ userId })),
      dedupeKey: `mention:${message.id}`,
      collapseKey: `conversation:${id}`,
      title: `${author} mentioned you${conversation.name ? ` in ${conversation.name}` : ''}`,
      body: preview,
      conversationId: id,
    });
    if (conversation.kind === 'dm') {
      const others = conversation.participants
        .filter((p) => p.participantType === 'user' && p.participantId !== request.user!.id && !mentioned.includes(p.participantId));
      void emitNotification(app.db, {
        type: 'dm.created',
        recipients: others.map((p) => ({ userId: p.participantId })),
        dedupeKey: `dm:${message.id}`,
        collapseKey: `conversation:${id}`,
        title: `New message from ${author}`,
        body: preview,
        conversationId: id,
      });
    }

    // A DM always goes to its agent. In a group or channel only the mentioned agents
    // answer, so a busy channel does not wake every agent in it.
    const respondingAgentIds = dmAgentId ? [dmAgentId] : mentionedAgentIds(conversation, body.mentions);
    const failed = (agentId: string, code: string, error: string, runId?: string) =>
      hub.publish(`user:${request.user!.id}`, 'agent.run.failed', {
        conversationId: id, messageId: message.id, agentId, code, error, ...(runId ? { runId } : {}),
      });

    for (const agentId of respondingAgentIds) {
      const agent = getAgent(app.db, agentId);
      const agentName = agent?.name ?? 'The agent';
      if (!agent || !getProviderConfig(app.db, agent.modelPolicy.defaultProviderId)) {
        failed(
          agentId,
          'provider_not_configured',
          `${agentName} could not reply: no model provider is configured for it. Add one in Settings → Providers.`
        );
        continue;
      }
      void runAgentTurn(
        { db: app.db, hub, respond, queue: app.runQueue, onAgentChange: (changed) => app.agentStatus.refresh(changed) },
        { agentId, conversationId: id, trigger: 'message', triggerMessageId: message.id },
      ).catch((error: unknown) => {
        const failure = describeAgentFailure(error, agentName);
        failed(agentId, failure.code, failure.message, runIdOfFailure(error));
      });
    }
  });

  app.get('/api/v1/conversations/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // A public channel can be read before it is joined; everything else takes membership.
    if (!isParticipant(app.db, id, request.user!.id, 'user') && !canReadChannel(app.db, id, request.user!.id)) {
      reply.code(403).send({ error: 'not_a_participant' });
      return;
    }
    const query = ListMessagesQuerySchema.parse(request.query);
    reply.send(listMessagesForConversation(app.db, id, query.limit));
  });
}
