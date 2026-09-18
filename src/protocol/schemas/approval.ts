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
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(['approve', 'deny']),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
