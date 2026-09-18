import { z } from 'zod';
import { ActorTypeSchema } from './common.js';

export const MentionRefSchema = z.object({
  targetId: z.string().min(1),
  targetType: ActorTypeSchema,
});
export type MentionRef = z.infer<typeof MentionRefSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  authorId: z.string().min(1),
  authorType: ActorTypeSchema,
  body: z.string().min(1),
  mentions: z.array(MentionRefSchema).default([]),
  replyToMessageId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof MessageSchema>;
