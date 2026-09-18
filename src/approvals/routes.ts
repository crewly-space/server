import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import type { Role } from '../users/repository.js';
import {
  ApprovalAlreadyResolvedError,
  getApproval,
  getApprovalForOwner,
  listPendingApprovals,
  listPendingApprovalsForOwner,
  resolveApproval,
} from './repository.js';

const RespondBodySchema = z.object({
  decision: z.enum(['approve', 'deny']),
});

export function registerApprovalRoutes(app: FastifyInstance): void {
  app.get('/api/v1/approvals', { preHandler: requireAuth }, async (request, reply) => {
    const role = request.user!.role as Role;
    reply.send(role === 'owner' || role === 'admin'
      ? listPendingApprovals(app.db)
      : listPendingApprovalsForOwner(app.db, request.user!.id));
  });

  app.post('/api/v1/approvals/:id/respond', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const role = request.user!.role as Role;
    const approval = role === 'owner' || role === 'admin'
      ? getApproval(app.db, id)
      : getApprovalForOwner(app.db, id, request.user!.id);
    if (!approval) {
      reply.code(404).send({ error: 'approval_not_found' });
      return;
    }
    const body = RespondBodySchema.parse(request.body);
    try {
      reply.send(resolveApproval(app.db, id, body.decision));
    } catch (err) {
      if (err instanceof ApprovalAlreadyResolvedError) {
        reply.code(409).send({ error: 'already_resolved' });
        return;
      }
      throw err;
    }
  });
}
