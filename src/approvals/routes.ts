import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import type { ApprovalRequest } from '../protocol/index.js';
import type { Role } from '../users/repository.js';
import { executeApprovedToolCall, type ApprovedExecution, type ToolRuntimeOptions } from '../tools/runtime.js';
import {
  ApprovalAlreadyResolvedError,
  getApproval,
  getApprovalForOwner,
  listPendingApprovals,
  listPendingApprovalsForOwner,
  listResolvedApprovals,
  resolveApproval,
} from './repository.js';

const RespondBodySchema = z.object({
  decision: z.enum(['approve', 'deny']),
  /** Approve, and let this agent use this tool without asking from now on. */
  remember: z.boolean().optional(),
});

export interface ApprovalRouteOptions {
  /** Without it, approving a tool call records the decision but runs nothing. */
  toolRuntime?: ToolRuntimeOptions;
  /** Told once an approved tool call has run, to report it and let the agent carry on. */
  onToolExecuted?: (approval: ApprovalRequest, execution: ApprovedExecution) => void | Promise<void>;
}

export function registerApprovalRoutes(app: FastifyInstance, options: ApprovalRouteOptions = {}): void {
  const isAdmin = (role: Role) => role === 'owner' || role === 'admin';

  app.get('/api/v1/approvals', { preHandler: requireAuth }, async (request, reply) => {
    const role = request.user!.role as Role;
    reply.send(isAdmin(role)
      ? listPendingApprovals(app.db)
      : listPendingApprovalsForOwner(app.db, request.user!.id));
  });

  /** Decided approvals, for the record: who approved what, and what then ran. */
  app.get('/api/v1/approvals/history', { preHandler: requireAuth }, async (request, reply) => {
    const role = request.user!.role as Role;
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    reply.send(listResolvedApprovals(app.db, { limit, ownerUserId: isAdmin(role) ? undefined : request.user!.id }));
  });

  app.post('/api/v1/approvals/:id/respond', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const role = request.user!.role as Role;
    const approval = isAdmin(role)
      ? getApproval(app.db, id)
      : getApprovalForOwner(app.db, id, request.user!.id);
    if (!approval) {
      reply.code(404).send({ error: 'approval_not_found' });
      return;
    }
    const body = RespondBodySchema.parse(request.body);
    let resolved: ApprovalRequest;
    try {
      resolved = resolveApproval(app.db, id, body.decision, request.user!.id);
    } catch (err) {
      if (err instanceof ApprovalAlreadyResolvedError) {
        reply.code(409).send({ error: 'already_resolved' });
        return;
      }
      throw err;
    }
    app.agentStatus.refresh(resolved.agentId);
    if (body.decision === 'approve' && resolved.details.kind === 'tool' && options.toolRuntime) {
      const execution = await executeApprovedToolCall(app.db, id, { userId: request.user!.id, remember: body.remember }, options.toolRuntime);
      resolved = getApproval(app.db, id)!;
      if (execution.status !== 'skipped') {
        try {
          await options.onToolExecuted?.(resolved, execution);
        } catch (error) {
          app.log.warn({ err: error }, 'reporting an approved tool call failed');
        }
      }
    }
    reply.send(resolved);
  });
}
