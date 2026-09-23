import { z } from 'zod';
import { AvatarModeSchema } from './common.js';

export const ModelPolicySchema = z.object({
  defaultProviderId: z.string().min(1),
  defaultModel: z.string().min(1),
  fallbackProviderId: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional(),
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

export const PermissionSetSchema = z.object({
  tools: z.array(z.string()).default([]),
  canMessageAgents: z.boolean().default(true),
  canApproveOwnActions: z.boolean().default(false),
});
export type PermissionSet = z.infer<typeof PermissionSetSchema>;

export const RelationshipRefSchema = z.object({
  agentId: z.string().min(1),
  label: z.string().min(1),
});
export type RelationshipRef = z.infer<typeof RelationshipRefSchema>;

export const AgentSchema = z
  .object({
    id: z.string().min(1),
    ownerUserId: z.string().min(1),
    name: z.string().min(1),
    personality: z.string().default(''),
    modelPolicy: ModelPolicySchema,
    permissions: PermissionSetSchema.default({}),
    relationships: z.array(RelationshipRefSchema).default([]),
    /** `dnd` keeps the agent out of automatic invocation; `auto` lets presence follow what it is doing. */
    availability: z.enum(['auto', 'dnd']).default('auto'),
    avatarMode: AvatarModeSchema.default('bloop'),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Agent = z.infer<typeof AgentSchema>;

/**
 * Field names a runtime integration might be tempted to bolt onto Agent directly.
 * AgentSchema is `.strict()`, so any object carrying one of these fails to parse —
 * vendor session state belongs on RuntimeBinding.vendorState instead.
 */
export const FORBIDDEN_AGENT_FIELDS = [
  'runtimeSessionId',
  'claudeSessionId',
  'codexSessionId',
  'geminiSessionId',
  'vendorSessionId',
  'runtimeId',
  'threadId',
] as const;

export const AgentPresenceSchema = z.enum(['online', 'idle', 'dnd', 'offline']);
export type AgentPresence = z.infer<typeof AgentPresenceSchema>;

export const AgentExecutionStateSchema = z.enum([
  'ready',
  'working',
  'waiting_approval',
  'queued',
  'error',
  'runtime_unavailable',
  'provider_unavailable',
]);
export type AgentExecutionState = z.infer<typeof AgentExecutionStateSchema>;

/**
 * What an agent is doing and whether it can be reached, derived on the server
 * from runs, approvals, providers, devices and runtimes -- never guessed by a
 * client. Presence and execution are separate: `online · working`, `dnd · ready`.
 */
export const AgentStatusSchema = z.object({
  agentId: z.string().min(1),
  presence: AgentPresenceSchema,
  execution: AgentExecutionStateSchema,
  /** Why, in words: "Claude device offline", "Waiting for approval". */
  reason: z.string().nullable(),
  availability: z.enum(['auto', 'dnd']),
  /** The run it is working on, queued behind, or waiting on approval for. */
  activeRunId: z.string().nullable(),
  lastActiveAt: z.string().datetime().nullable(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
