import { z } from 'zod';

export const MemoryFactSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  content: z.string().min(1),
  source: z.enum(['conversation', 'manual', 'summary']),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

export const ConversationSummarySchema = z.object({
  conversationId: z.string().min(1),
  summary: z.string().min(1),
  upToMessageId: z.string().min(1),
  updatedAt: z.string().datetime(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
