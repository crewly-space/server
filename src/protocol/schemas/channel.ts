import { z } from 'zod';
import { ParticipantRefSchema } from './conversation.js';

export const ChannelVisibilitySchema = z.enum(['public', 'private']);
export type ChannelVisibility = z.infer<typeof ChannelVisibilitySchema>;

/** The least server role a channel member needs to post in it. */
export const ChannelPostRoleSchema = z.enum(['member', 'admin', 'owner']);
export type ChannelPostRole = z.infer<typeof ChannelPostRoleSchema>;

/** A sidebar section that channels are sorted into. */
export const ChannelCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int(),
});
export type ChannelCategory = z.infer<typeof ChannelCategorySchema>;

/**
 * A channel as its reader sees it. The channel's id is its conversation id,
 * so messages, mentions and runs use the conversation routes unchanged.
 */
export const ChannelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  topic: z.string().nullable(),
  visibility: ChannelVisibilitySchema,
  postRole: ChannelPostRoleSchema,
  categoryId: z.string().nullable(),
  position: z.number().int(),
  archivedAt: z.string().datetime().nullable(),
  members: z.array(ParticipantRefSchema),
  /** Agents an admin has kept out of the channel. */
  blockedAgentIds: z.array(z.string()),
  /** Whether the reader is a member: a public channel can be read before joining. */
  joined: z.boolean(),
  /** Whether the reader may post: a member whose server role meets postRole, in a channel not archived. */
  canPost: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const ChannelListSchema = z.object({
  channels: z.array(ChannelSchema),
  categories: z.array(ChannelCategorySchema),
});
export type ChannelList = z.infer<typeof ChannelListSchema>;
