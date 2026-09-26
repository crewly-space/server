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
  artifact: z.object({
    id: z.string().min(1),
    runId: z.string().min(1),
    agentId: z.string().min(1),
  }).nullable().default(null),
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
  threadRootId: z.string().min(1).nullable().optional(),
  thread: z.object({
    status: z.enum(['open', 'resolved', 'archived']),
    replyCount: z.number().int().nonnegative(),
    latestActivityAt: z.string().datetime(),
    unread: z.boolean(),
  }).nullable().optional(),
  createdAt: z.string().datetime(),
  attachments: z.array(AttachmentSchema).default([]),
}).superRefine((message, context) => {
  if (message.body.trim().length === 0 && message.attachments.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'message needs text or an attachment' });
  }
});
export type Message = z.infer<typeof MessageSchema>;
