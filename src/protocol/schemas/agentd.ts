import { z } from 'zod';

export const AgentdOperationNameSchema = z.enum([
  'runtime.run',
  'runtime.resume',
  'provider.chat',
  'provider.models',
  'workspace.list',
  'approval.respond',
]);
export type AgentdOperationName = z.infer<typeof AgentdOperationNameSchema>;

export const AgentdRequestSchema = z.object({
  requestId: z.string().min(1),
  operation: AgentdOperationNameSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type AgentdRequest = z.infer<typeof AgentdRequestSchema>;

export const AgentdResponseSchema = z.object({
  requestId: z.string().min(1),
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type AgentdResponse = z.infer<typeof AgentdResponseSchema>;

export const AgentdEventSchema = z.object({
  runId: z.string().min(1),
  seq: z.number().int().min(0),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type AgentdEvent = z.infer<typeof AgentdEventSchema>;

export const AgentdChallengeSchema = z.object({
  type: z.literal('challenge'),
  nonce: z.string().min(1),
});
export type AgentdChallenge = z.infer<typeof AgentdChallengeSchema>;

export const AgentdAuthenticateSchema = z.object({
  type: z.literal('authenticate'),
  deviceId: z.string().regex(/^dev_[0-9a-f]{20}$/),
  timestamp: z.string().datetime(),
  nonce: z.string().min(1),
  signature: z.string().min(40),
});
export type AgentdAuthenticate = z.infer<typeof AgentdAuthenticateSchema>;

export const AgentdHeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});
export type AgentdHeartbeat = z.infer<typeof AgentdHeartbeatSchema>;
