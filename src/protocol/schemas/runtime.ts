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

export const AgentRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunSchema = z.object({
  runId: z.string().min(1),
  rootRunId: z.string().min(1),
  causationId: z.string().min(1).nullable(),
  hopCount: z.number().int().min(0).max(DEFAULT_MAX_HOP_COUNT),
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  createdAt: z.string().datetime(),
  status: AgentRunStatusSchema.optional(),
  /** What started the run: `message`, `delegation` or `api`. */
  trigger: z.string().min(1).optional(),
  triggerMessageId: z.string().min(1).nullable().optional(),
  resultMessageId: z.string().min(1).nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  finishedAt: z.string().datetime().nullable().optional(),
  errorCode: z.string().min(1).nullable().optional(),
  errorMessage: z.string().nullable().optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;
