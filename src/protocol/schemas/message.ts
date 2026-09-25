import { z } from 'zod';
import { ActorTypeSchema } from './common.js';

export const MentionRefSchema = z.object({
  targetId: z.string().min(1),
  targetType: ActorTypeSchema,
});
export type MentionRef = z.infer<typeof MentionRefSchema>;

export const AttachmentSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  messageId: z.string().min(1).nullable(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  createdAt: z.string().datetime(),
  url: z.string().min(1),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  authorId: z.string().min(1),
  authorType: ActorTypeSchema,
  body: z.string(),
  mentions: z.array(MentionRefSchema).default([]),
  replyToMessageId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  attachments: z.array(AttachmentSchema).default([]),
});
export type Message = z.infer<typeof MessageSchema>;
