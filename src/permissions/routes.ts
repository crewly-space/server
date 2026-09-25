import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { listUsers } from '../users/repository.js';
import {
  assertCanManageRole,
  assignRole,
  createRole,
  deleteRole,
  getRole,
  hasPermission,
  listRoles,
  listRolesForUser,
  PERMISSION_DEFINITIONS,
  RoleForbiddenError,
  RoleValidationError,
  unassignRole,
  updateRole,
} from './roles.js';

const RoleBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(240).optional(),
  permissions: z.array(z.string()).max(30),
});

function sendRoleError(reply: { code: (status: number) => { send: (body: unknown) => void }; send: (body: unknown) => void }, error: unknown): void {
  if (error instanceof RoleForbiddenError) { reply.code(403).send({ error: error.message }); return; }
  if (error instanceof RoleValidationError) { reply.code(error.message === 'role_not_found' || error.message === 'user_not_found' ? 404 : 400).send({ error: error.message }); return; }
  throw error;
}

function canReadRoles(app: FastifyInstance, userId: string): boolean {
  return hasPermission(app.db, userId, 'roles.manage');
}

export function registerPermissionRoutes(app: FastifyInstance): void {
  app.get('/api/v1/roles', { preHandler: requireAuth }, async (request, reply) => {
    if (!canReadRoles(app, request.user!.id)) { reply.code(403).send({ error: 'roles_manage_required' }); return; }
    reply.send({
      permissions: PERMISSION_DEFINITIONS,
      roles: listRoles(app.db),
      members: listUsers(app.db).map((user) => ({
        userId: user.id,
        roles: listRolesForUser(app.db, user.id).map((role) => role.id),
      })),
    });
  });

  app.post('/api/v1/roles', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const body = RoleBodySchema.parse(request.body);
      assertCanManageRole(app.db, request.user!.id, body.permissions);
      reply.code(201).send(createRole(app.db, { ...body, createdBy: request.user!.id }));
    } catch (error) { sendRoleError(reply, error); }
  });

  app.patch('/api/v1/roles/:id', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const body = RoleBodySchema.parse(request.body);
      assertCanManageRole(app.db, request.user!.id, body.permissions);
      reply.send(updateRole(app.db, (request.params as { id: string }).id, body));
    } catch (error) { sendRoleError(reply, error); }
  });

  app.delete('/api/v1/roles/:id', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!canReadRoles(app, request.user!.id)) throw new RoleForbiddenError('roles_manage_required');
      if (!deleteRole(app.db, (request.params as { id: string }).id)) { reply.code(404).send({ error: 'role_not_found' }); return; }
      reply.code(204).send();
    } catch (error) { sendRoleError(reply, error); }
  });

  app.put('/api/v1/roles/:id/members/:userId', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { id, userId } = request.params as { id: string; userId: string };
      const role = getRole(app.db, id);
      if (!role) { reply.code(404).send({ error: 'role_not_found' }); return; }
      assertCanManageRole(app.db, request.user!.id, role.permissions);
      assignRole(app.db, id, userId, request.user!.id);
      reply.code(204).send();
    } catch (error) { sendRoleError(reply, error); }
  });

  app.delete('/api/v1/roles/:id/members/:userId', { preHandler: requireAuth }, async (request, reply) => {
    try {
      unassignRole(app.db, (request.params as { id: string }).id, (request.params as { userId: string }).userId, request.user!.id);
      reply.code(204).send();
    } catch (error) { sendRoleError(reply, error); }
  });
}
