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

/** A tool the model may call, described the way every provider can be told about it. */
export const ToolDefinitionSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string().default(''),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/** One call the model asked for. `id` pairs it with the result sent back. */
export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  /** On an assistant turn: the tools it asked to have run. */
  toolCalls: z.array(ToolCallSchema).optional(),
  /** On a tool turn: which call this is the result of. */
  toolCallId: z.string().min(1).optional(),
  /** On a tool turn: the result is an error rather than an answer. */
  isError: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  content: z.string(),
  stopReason: z.enum(['end_turn', 'max_tokens', 'tool_use', 'error']),
  toolCalls: z.array(ToolCallSchema).optional(),
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
