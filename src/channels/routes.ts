import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAgent } from '../agents/repository.js';
import { requireAuth } from '../auth/middleware.js';
import { getUserById, type Role } from '../users/repository.js';
import { ChannelPostRoleSchema, ChannelVisibilitySchema } from '../protocol/index.js';
import {
  addMember,
  canReadChannel,
  channelNameTaken,
  createCategory,
  createChannel,
  deleteCategory,
  getCategory,
  getChannel,
  isAgentBlocked,
  isChannelAdmin,
  isMember,
  listCategories,
  listChannels,
  orderCategories,
  orderChannels,
  removeMember,
  renameCategory,
  setAgentBlocked,
  updateChannel,
  type Reader,
} from './repository.js';

/** Server-wide: every socket hears that a channel changed, and refetches what it may see. */
export const CHANNELS_TOPIC = 'channels';

/**
 * A channel name as it is shown after the #: lower case, words joined by
 * dashes, letters, digits, dashes and underscores only.
 */
const ChannelNameSchema = z
  .string()
  .transform((name) => name.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-'))
  .pipe(z.string().min(1).max(80).regex(/^[\p{L}\p{N}_-]+$/u, 'letters, numbers, dashes and underscores only'));

const TopicSchema = z.string().trim().max(250).transform((topic) => topic || null).nullable();

const MemberSchema = z.object({ participantId: z.string().min(1), participantType: z.enum(['user', 'agent']) });

const CreateChannelSchema = z.object({
  name: ChannelNameSchema,
  topic: TopicSchema.default(null),
  visibility: ChannelVisibilitySchema.default('public'),
  postRole: ChannelPostRoleSchema.default('member'),
  categoryId: z.string().min(1).nullable().default(null),
  members: z.array(MemberSchema).default([]),
});

const UpdateChannelSchema = z.object({
  name: ChannelNameSchema.optional(),
  topic: TopicSchema.optional(),
  visibility: ChannelVisibilitySchema.optional(),
  postRole: ChannelPostRoleSchema.optional(),
  categoryId: z.string().min(1).nullable().optional(),
  archived: z.boolean().optional(),
});

const OrderChannelsSchema = z.object({
  categoryId: z.string().min(1).nullable(),
  channelIds: z.array(z.string().min(1)).max(500),
});

const CategoryNameSchema = z.object({ name: z.string().trim().min(1).max(60) });
const OrderCategoriesSchema = z.object({ categoryIds: z.array(z.string().min(1)).max(200) });

const ListQuerySchema = z.object({
  includeArchived: z.enum(['true', 'false', '1', '0']).optional().transform((value) => value === 'true' || value === '1'),
});

function reader(request: FastifyRequest): Reader {
  return { id: request.user!.id, role: request.user!.role as Role };
}

function requireChannelAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isChannelAdmin(request.user!.role as Role)) return true;
  reply.code(403).send({ error: 'forbidden' });
  return false;
}

function memberExists(app: FastifyInstance, member: z.infer<typeof MemberSchema>): boolean {
  if (member.participantType === 'user') {
    const user = getUserById(app.db, member.participantId);
    return user !== undefined && !user.suspended_at;
  }
  return getAgent(app.db, member.participantId) !== undefined;
}

export function registerChannelRoutes(app: FastifyInstance): void {
  const changed = (channelId: string | null) => app.hub.publish(CHANNELS_TOPIC, 'channels.changed', { channelId });
  const topic = (channelId: string) => `conversation:${channelId}`;

  /** Loads a channel the caller can see, or answers 404, so a private channel's existence does not leak. */
  function load(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string };
    const channel = getChannel(app.db, id, reader(request));
    if (!channel) reply.code(404).send({ error: 'channel_not_found' });
    return channel;
  }

  app.get('/api/v1/channels', { preHandler: requireAuth }, async (request, reply) => {
    const query = ListQuerySchema.parse(request.query);
    reply.send({
      channels: listChannels(app.db, reader(request), { includeArchived: query.includeArchived }),
      categories: listCategories(app.db),
    });
  });

  app.get('/api/v1/channels/:id', { preHandler: requireAuth }, async (request, reply) => {
    const channel = load(request, reply);
    if (channel) reply.send(channel);
  });

  app.post('/api/v1/channels', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    const body = CreateChannelSchema.parse(request.body);
    if (channelNameTaken(app.db, body.name)) {
      reply.code(409).send({ error: 'channel_name_taken' });
      return;
    }
    if (body.categoryId && !getCategory(app.db, body.categoryId)) {
      reply.code(404).send({ error: 'category_not_found' });
      return;
    }
    for (const member of body.members) {
      if (!memberExists(app, member)) {
        reply.code(404).send({ error: 'participant_not_found' });
        return;
      }
    }
    // Whoever creates a channel is in it, so a private one is never born unreachable.
    const creator = { participantId: request.user!.id, participantType: 'user' as const };
    const channel = createChannel(app.db, {
      name: body.name,
      topic: body.topic,
      visibility: body.visibility,
      postRole: body.postRole,
      categoryId: body.categoryId,
      createdBy: request.user!.id,
      members: [creator, ...body.members],
    }, reader(request));
    for (const member of channel.members) {
      if (member.participantType === 'user') app.hub.addUserTopic(member.participantId, topic(channel.id));
    }
    changed(channel.id);
    reply.code(201).send(channel);
  });

  app.patch('/api/v1/channels/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    const channel = load(request, reply);
    if (!channel) return;
    const body = UpdateChannelSchema.parse(request.body);
    // Bringing an archived channel back, or renaming one, must not make two live channels share a name.
    const name = body.name ?? channel.name;
    const live = body.archived === undefined ? !channel.archivedAt : !body.archived;
    if (live && (body.name !== undefined || body.archived === false) && channelNameTaken(app.db, name, channel.id)) {
      reply.code(409).send({ error: 'channel_name_taken' });
      return;
    }
    if (body.categoryId && !getCategory(app.db, body.categoryId)) {
      reply.code(404).send({ error: 'category_not_found' });
      return;
    }
    updateChannel(app.db, channel.id, body);
    changed(channel.id);
    reply.send(getChannel(app.db, channel.id, reader(request)));
  });

  app.put('/api/v1/channels/order', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    const body = OrderChannelsSchema.parse(request.body);
    if (body.categoryId && !getCategory(app.db, body.categoryId)) {
      reply.code(404).send({ error: 'category_not_found' });
      return;
    }
    orderChannels(app.db, body.categoryId, body.channelIds);
    changed(null);
    reply.code(204).send();
  });

  app.post('/api/v1/channels/:id/join', { preHandler: requireAuth }, async (request, reply) => {
    const channel = load(request, reply);
    if (!channel) return;
    // Private channels are joined by being added, never by asking.
    if (channel.visibility !== 'public' && !channel.joined) {
      reply.code(403).send({ error: 'channel_private' });
      return;
    }
    if (channel.archivedAt) {
      reply.code(409).send({ error: 'channel_archived' });
      return;
    }
    addMember(app.db, channel.id, { participantId: request.user!.id, participantType: 'user' });
    app.hub.addUserTopic(request.user!.id, topic(channel.id));
    changed(channel.id);
    reply.send(getChannel(app.db, channel.id, reader(request)));
  });

  app.post('/api/v1/channels/:id/leave', { preHandler: requireAuth }, async (request, reply) => {
    const channel = load(request, reply);
    if (!channel) return;
    removeMember(app.db, channel.id, { participantId: request.user!.id, participantType: 'user' });
    app.hub.removeUserTopic(request.user!.id, topic(channel.id));
    changed(channel.id);
    reply.code(204).send();
  });

  app.post('/api/v1/channels/:id/members', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    const channel = load(request, reply);
    if (!channel) return;
    const member = MemberSchema.parse(request.body);
    if (!memberExists(app, member)) {
      reply.code(404).send({ error: 'participant_not_found' });
      return;
    }
    if (member.participantType === 'agent' && isAgentBlocked(app.db, channel.id, member.participantId)) {
      reply.code(409).send({ error: 'agent_blocked' });
      return;
    }
    addMember(app.db, channel.id, member);
    if (member.participantType === 'user') app.hub.addUserTopic(member.participantId, topic(channel.id));
    changed(channel.id);
    reply.send(getChannel(app.db, channel.id, reader(request)));
  });

  app.delete('/api/v1/channels/:id/members/:participantType/:participantId', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    const channel = load(request, reply);
    if (!channel) return;
    const { participantType, participantId } = MemberSchema.parse(request.params);
    removeMember(app.db, channel.id, { participantId, participantType });
    if (participantType === 'user') app.hub.removeUserTopic(participantId, topic(channel.id));
    changed(channel.id);
    reply.send(getChannel(app.db, channel.id, reader(request)));
  });

  app.put('/api/v1/channels/:id/agents/:agentId/block', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    const channel = load(request, reply);
    if (!channel) return;
    const { agentId } = request.params as { agentId: string };
    if (!getAgent(app.db, agentId)) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    setAgentBlocked(app.db, channel.id, agentId, true, request.user!.id);
    changed(channel.id);
    reply.send(getChannel(app.db, channel.id, reader(request)));
  });

  app.delete('/api/v1/channels/:id/agents/:agentId/block', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    const channel = load(request, reply);
    if (!channel) return;
    const { agentId } = request.params as { agentId: string };
    setAgentBlocked(app.db, channel.id, agentId, false, request.user!.id);
    changed(channel.id);
    reply.send(getChannel(app.db, channel.id, reader(request)));
  });

  app.post('/api/v1/channel-categories', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    const body = CategoryNameSchema.parse(request.body);
    const category = createCategory(app.db, body.name);
    changed(null);
    reply.code(201).send(category);
  });

  app.patch('/api/v1/channel-categories/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!getCategory(app.db, id)) {
      reply.code(404).send({ error: 'category_not_found' });
      return;
    }
    renameCategory(app.db, id, CategoryNameSchema.parse(request.body).name);
    changed(null);
    reply.send(getCategory(app.db, id));
  });

  app.delete('/api/v1/channel-categories/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!getCategory(app.db, id)) {
      reply.code(404).send({ error: 'category_not_found' });
      return;
    }
    deleteCategory(app.db, id);
    changed(null);
    reply.code(204).send();
  });

  app.put('/api/v1/channel-categories/order', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireChannelAdmin(request, reply)) return;
    orderCategories(app.db, OrderCategoriesSchema.parse(request.body).categoryIds);
    changed(null);
    reply.code(204).send();
  });
}
