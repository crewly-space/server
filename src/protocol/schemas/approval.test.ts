import { describe, expect, it } from 'vitest';
import { ApprovalDecisionSchema, ApprovalRequestSchema } from './approval.js';

const now = '2026-01-01T00:00:00.000Z';

describe('ApprovalRequestSchema', () => {
  it('parses a pending approval request', () => {
    const request = ApprovalRequestSchema.parse({
      id: 'approval_1',
      runId: 'run_1',
      agentId: 'agent_1',
      action: 'send_email',
      details: { to: 'user@example.com' },
      status: 'pending',
      createdAt: now,
      resolvedAt: null,
    });
    expect(request.status).toBe('pending');
  });
});

describe('ApprovalDecisionSchema', () => {
  it('parses an approve decision without a reason', () => {
    const decision = ApprovalDecisionSchema.parse({ approvalId: 'approval_1', decision: 'approve' });
    expect(decision.decision).toBe('approve');
  });
});
