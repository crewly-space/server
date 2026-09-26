import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getConversation, isParticipant } from '../conversations/repository.js';
import { effectiveAgentRoutingMode, getAgent } from '../agents/repository.js';
import { getProviderConfig } from '../providers/repository.js';
import { describeAgentFailure } from '../providers/errors.js';
import { runAgentTurn, runIdOfFailure, type RespondFn } from '../runtime/engine.js';
import { enqueueJob } from '../jobs/repository.js';
import { SUMMARIZE_CONVERSATION_JOB_TYPE } from '../memory/summary.js';
import type { ConnectionHub } from '../ws/hub.js';
import { emitNotification } from '../notifications/service.js';
import { getUserById, type Role } from '../users/repository.js';
import { blockedAgentIds, canReadChannel, getChannel } from '../channels/repository.js';
import { createMessage, getMessageThread, listMessagesForConversation, listThreadMessages, markThreadRead, openMessageThread, ReplyNotInConversationError, searchMessages, setThreadStatus } from './repository.js';
import { AttachmentNotOwnedError, AttachmentValidationError, ATTACHMENT_MAX_COUNT_PER_MESSAGE } from '../attachments/service.js';
import { decideAgentRouting } from './routing.js';
import { dispatchAutomationEvent } from '../automations/service.js';

const CreateMessageBodySchema = z.object({
  body: z.string().max(100_000).default(''),
  mentions: z
    .array(z.object({ targetId: z.string().min(1), targetType: z.enum(['user', 'agent']) }))
    .default([]),
  replyToMessageId: z.string().min(1).nullable().default(null),
  attachmentIds: z.array(z.string().min(1)).max(ATTACHMENT_MAX_COUNT_PER_MESSAGE).default([]),
}).refine((body) => body.body.trim().length > 0 || body.attachmentIds.length > 0, { message: 'message needs text or an attachment' });

const ListMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});

type MentionRef = { targetId: string; targetType: 'user' | 'agent' };

function explicitlyMentioned(mentions: MentionRef[], agentId: string): boolean {
  return mentions.some((mention) => mention.targetType === 'agent' && mention.targetId === agentId);
}

export function registerMessageRoutes(app: FastifyInstance, hub: ConnectionHub, respond: RespondFn): void {
  const automationDispatch = (event: { type: 'message' | 'run'; eventId: string; dedupeKey: string; payload: Record<string, unknown>; conversationId?: string; hopCount?: number }) =>
    dispatchAutomationEvent({ db: app.db, hub, respond, queue: app.runQueue, automationDispatch }, event);
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
        attachmentIds: body.attachmentIds,
      });
    } catch (err) {
      if (err instanceof ReplyNotInConversationError) {
        reply.code(400).send({ error: 'invalid_reply' });
        return;
      }
      if (err instanceof AttachmentNotOwnedError) {
        reply.code(409).send({ error: 'attachment_unavailable', message: err.message });
        return;
      }
      if (err instanceof AttachmentValidationError || (err instanceof Error && err.message === 'message_body_or_attachment_required')) {
        reply.code(400).send({ error: 'invalid_message', message: err.message });
        return;
      }
      throw err;
    }

    hub.publish(`conversation:${id}`, 'message.created', { ...message });
    void dispatchAutomationEvent({
      db: app.db,
      hub,
      respond,
      queue: app.runQueue,
      automationDispatch,
    }, {
      type: 'message',
      eventId: message.id,
      dedupeKey: message.id,
      conversationId: id,
      payload: { messageId: message.id, conversationId: id, body: message.body, authorId: message.authorId, authorType: message.authorType },
    });
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

    // A DM always goes to its agent. In shared conversations, each participant's
    // effective global/channel mode decides whether it is woken. Explicit mentions
    // are direct requests; channel blocks remain the permission boundary.
    const candidates = dmAgentId
      ? [dmAgentId]
      : conversation.participants
        .filter((participant) => participant.participantType === 'agent')
        .map((participant) => participant.participantId);
    const blocked = new Set(conversation.kind === 'channel' ? blockedAgentIds(app.db, id) : []);
    const decisions = candidates.map((agentId) => {
      const agent = getAgent(app.db, agentId);
      const mode = dmAgentId ? 'always' as const : (effectiveAgentRoutingMode(app.db, agentId, id) ?? 'mention_only');
      return {
        agentId,
        agent,
        decision: agent
          ? decideAgentRouting(agent, mode, body.body, explicitlyMentioned(body.mentions, agentId), blocked.has(agentId), Boolean(dmAgentId))
          : { shouldRespond: false, mode, reason: 'blocked' as const },
      };
    });
    const respondingAgentIds = [...new Set(decisions.filter(({ decision }) => decision.shouldRespond).map(({ agentId }) => agentId))];
    const failed = (agentId: string, code: string, error: string, runId?: string) =>
      hub.publish(`user:${request.user!.id}`, 'agent.run.failed', {
        conversationId: id, messageId: message.id, agentId, code, error, ...(runId ? { runId } : {}),
      });

    for (const agentId of respondingAgentIds) {
      const agent = decisions.find((entry) => entry.agentId === agentId)?.agent ?? getAgent(app.db, agentId);
      const decision = decisions.find((entry) => entry.agentId === agentId)?.decision;
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
        { db: app.db, hub, respond, queue: app.runQueue, automationDispatch, onAgentChange: (changed) => app.agentStatus.refresh(changed) },
        {
          agentId,
          conversationId: id,
          trigger: 'message',
          triggerMessageId: message.id,
          routingDecision: decision ? { mode: decision.mode, reason: decision.reason } : undefined,
        },
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
    reply.send(listMessagesForConversation(app.db, id, query.limit, request.user!.id));
  });

  app.post('/api/v1/messages/:id/thread', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const root = app.db.prepare('SELECT conversation_id FROM messages WHERE id = ? AND thread_root_id IS NULL').get(id) as { conversation_id: string } | undefined;
      if (!root) { reply.code(404).send({ error: 'message_not_found' }); return; }
      if (!isParticipant(app.db, root.conversation_id, request.user!.id, 'user') && !canReadChannel(app.db, root.conversation_id, request.user!.id)) {
        reply.code(403).send({ error: 'not_a_participant' }); return;
      }
      const thread = openMessageThread(app.db, id, request.user!.id);
      reply.code(201).send(thread);
    } catch (error) {
      if (error instanceof Error && error.message === 'thread_root_not_found') { reply.code(404).send({ error: 'message_not_found' }); return; }
      throw error;
    }
  });

  app.get('/api/v1/threads/:rootId/messages', { preHandler: requireAuth }, async (request, reply) => {
    const { rootId } = request.params as { rootId: string };
    const thread = getMessageThread(app.db, rootId);
    if (!thread) { reply.code(404).send({ error: 'thread_not_found' }); return; }
    if (!isParticipant(app.db, thread.conversationId, request.user!.id, 'user') && !canReadChannel(app.db, thread.conversationId, request.user!.id)) {
      reply.code(403).send({ error: 'not_a_participant' }); return;
    }
    markThreadRead(app.db, rootId, request.user!.id);
    reply.send({ thread, messages: listThreadMessages(app.db, rootId, 200, request.user!.id) });
  });

  app.post('/api/v1/threads/:rootId/messages', { preHandler: requireAuth }, async (request, reply) => {
    const { rootId } = request.params as { rootId: string };
    const thread = getMessageThread(app.db, rootId);
    if (!thread) { reply.code(404).send({ error: 'thread_not_found' }); return; }
    if (thread.status !== 'open') { reply.code(409).send({ error: 'thread_closed' }); return; }
    if (!isParticipant(app.db, thread.conversationId, request.user!.id, 'user')) { reply.code(403).send({ error: 'not_a_participant' }); return; }
    const body = CreateMessageBodySchema.parse(request.body);
    const message = createMessage(app.db, { conversationId: thread.conversationId, authorId: request.user!.id, authorType: 'user',
      body: body.body, mentions: body.mentions, replyToMessageId: rootId, threadRootId: rootId, attachmentIds: body.attachmentIds });
    markThreadRead(app.db, rootId, request.user!.id);
    hub.publish(`conversation:${thread.conversationId}`, 'thread.message.created', { rootMessageId: rootId, message });
    for (const mention of body.mentions.filter((entry) => entry.targetType === 'agent')) {
      const agent = getAgent(app.db, mention.targetId);
      if (!agent || !getProviderConfig(app.db, agent.modelPolicy.defaultProviderId)) continue;
      void runAgentTurn({ db: app.db, hub, respond, queue: app.runQueue, onAgentChange: (changed) => app.agentStatus.refresh(changed) }, {
        agentId: agent.id, conversationId: thread.conversationId, trigger: 'thread_message', triggerMessageId: message.id, threadRootId: rootId,
      }).catch(() => undefined);
    }
    reply.code(201).send(message);
  });

  app.patch('/api/v1/threads/:rootId', { preHandler: requireAuth }, async (request, reply) => {
    const { rootId } = request.params as { rootId: string };
    const thread = getMessageThread(app.db, rootId);
    if (!thread) { reply.code(404).send({ error: 'thread_not_found' }); return; }
    if (!isParticipant(app.db, thread.conversationId, request.user!.id, 'user')) { reply.code(403).send({ error: 'not_a_participant' }); return; }
    const body = z.object({ status: z.enum(['open', 'resolved', 'archived']) }).parse(request.body);
    reply.send(setThreadStatus(app.db, rootId, body.status));
  });

  app.get('/api/v1/messages/search', { preHandler: requireAuth }, async (request, reply) => {
    const query = z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().positive().max(100).default(50) }).parse(request.query);
    reply.send({ messages: searchMessages(app.db, query.q, request.user!.id, query.limit) });
  });
}
