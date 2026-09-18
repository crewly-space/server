import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { hashPassword } from '../auth/password.js';
import { createUser, getUserByEmail, listUsers, type Role, type UserRow } from './repository.js';

const CreateUserBodySchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  password: z.string().min(12).max(256),
  role: z.enum(['admin', 'member']).default('member'),
});

function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
  };
}

function canManageUsers(role: string): role is Extract<Role, 'owner' | 'admin'> {
  return role === 'owner' || role === 'admin';
}

export function registerUserRoutes(app: FastifyInstance): void {
  app.get('/api/v1/users', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    reply.send(listUsers(app.db).map(publicUser));
  });

  app.post('/api/v1/users', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const body = CreateUserBodySchema.parse(request.body);
    if (body.role === 'admin' && request.user!.role !== 'owner') {
      reply.code(403).send({ error: 'owner_required_for_admin' });
      return;
    }
    const email = body.email.trim().toLowerCase();
    if (getUserByEmail(app.db, email)) {
      reply.code(409).send({ error: 'user_exists' });
      return;
    }
    const user = createUser(app.db, {
      email,
      displayName: body.displayName.trim(),
      passwordHash: hashPassword(body.password),
      role: body.role,
    });
    reply.code(201).send(publicUser(user));
  });
}
