import { z } from 'zod';

export const RuntimeKindSchema = z.enum(['native', 'claude-code', 'codex', 'gemini-cli']);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const RuntimeBindingSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  runtimeKind: RuntimeKindSchema,
  workspacePath: z.string().min(1),
  vendorState: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RuntimeBinding = z.infer<typeof RuntimeBindingSchema>;

export const RuntimeSessionStatusSchema = z.enum([
  'idle',
  'running',
  'waiting_approval',
  'error',
  'closed',
]);
export type RuntimeSessionStatus = z.infer<typeof RuntimeSessionStatusSchema>;

export const RuntimeSessionSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  runtimeBindingId: z.string().min(1),
  status: RuntimeSessionStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RuntimeSession = z.infer<typeof RuntimeSessionSchema>;

export const DEFAULT_MAX_HOP_COUNT = 4;

export const AgentRunSchema = z.object({
  runId: z.string().min(1),
  rootRunId: z.string().min(1),
  causationId: z.string().min(1).nullable(),
  hopCount: z.number().int().min(0).max(DEFAULT_MAX_HOP_COUNT),
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;
