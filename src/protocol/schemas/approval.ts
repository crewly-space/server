import { z } from 'zod';

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  action: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
  status: ApprovalStatusSchema,
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  /** Who approved or denied it. Absent from servers older than the tool platform. */
  resolvedBy: z.string().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  /** For a tool approval: what happened when the approved call ran. Metadata only. */
  execution: z.object({
    status: z.enum(['success', 'error', 'blocked', 'skipped']),
    toolRef: z.string().nullable(),
    content: z.string(),
  }).nullable().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['approve', 'deny']),
  reason: z.string().optional(),
  /** Approve, and let this agent use this tool without asking from now on. */
  remember: z.boolean().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
