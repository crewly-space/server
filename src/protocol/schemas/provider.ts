import { z } from 'zod';

export const REMOTE_PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'openrouter',
  'deepseek',
  'openai-compatible',
] as const;

export const AGENTD_BACKED_PROVIDER_KINDS = ['claude-subscription', 'ollama'] as const;

export const ProviderKindSchema = z.enum([...REMOTE_PROVIDER_KINDS, ...AGENTD_BACKED_PROVIDER_KINDS]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  content: z.string(),
  stopReason: z.enum(['end_turn', 'max_tokens', 'error']),
  usage: z.object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
  }),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;
