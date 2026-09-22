import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { hashPassword } from '../auth/password.js';
import { createSession } from '../auth/session.js';
import {
  consumeInvite,
  createInvite,
  findUsableInvite,
  listInvites,
  pruneExpiredInvites,
  revokeInvite,
} from './invites.js';
import {
  countOwners,
  createUser,
  deleteUser,
  getUserByEmail,
  getUserById,
  listUsers,
  setUserRole,
  setUserSuspended,
  type Role,
  type UserRow,
} from './repository.js';

const CreateUserBodySchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  password: z.string().min(12).max(256),
  role: z.enum(['admin', 'member']).default('member'),
});

const CreateInviteBodySchema = z.object({
  role: z.enum(['admin', 'member']).default('member'),
  label: z.string().trim().max(120).optional(),
});

const AcceptInviteBodySchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  password: z.string().min(12).max(256),
});

const UpdateUserBodySchema = z.object({ role: z.enum(['owner', 'admin', 'member']) });
const SuspensionBodySchema = z.object({ suspended: z.boolean() });

function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
    suspendedAt: user.suspended_at ?? null,
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

  /*
   * Inviting somebody, rather than inventing a password for them.
   *
   * Making an account for a colleague means choosing their password and then
   * sending it to them, which is a worse secret than the one it replaces. An
   * invite is a link they redeem with a password only they ever know.
   */
  app.post('/api/v1/invites', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const body = CreateInviteBodySchema.parse(request.body);
    if (body.role === 'admin' && request.user!.role !== 'owner') {
      reply.code(403).send({ error: 'owner_required_for_admin' });
      return;
    }
    pruneExpiredInvites(app.db);
    const { invite, code } = createInvite(app.db, {
      role: body.role,
      createdBy: request.user!.id,
      label: body.label ?? null,
    });
    // The only time the code is ever returned: it is stored hashed, so nothing
    // can read it back afterwards.
    reply.code(201).send({ invite: { ...invite, code } });
  });

  app.get('/api/v1/invites', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    reply.send({ invites: listInvites(app.db) });
  });

  app.delete('/api/v1/invites/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { id } = request.params as { id: string };
    if (!revokeInvite(app.db, id)) {
      reply.code(404).send({ error: 'invite_not_found' });
      return;
    }
    reply.code(204).send();
  });

  /*
   * Redeeming one. Deliberately unauthenticated: the code is the credential,
   * and the person holding it has no account here yet.
   */
  app.post('/api/v1/invites/:code/accept', async (request, reply) => {
    const { code } = request.params as { code: string };
    const invite = findUsableInvite(app.db, code);
    // Used, revoked, expired and never-existed all answer alike: none of them
    // is something the holder can act on.
    if (!invite) {
      reply.code(404).send({ error: 'invite_not_found' });
      return;
    }
    const body = AcceptInviteBodySchema.parse(request.body);
    const email = body.email.trim().toLowerCase();
    if (getUserByEmail(app.db, email)) {
      reply.code(409).send({ error: 'user_exists' });
      return;
    }
    const user = createUser(app.db, {
      email,
      displayName: body.displayName.trim(),
      passwordHash: hashPassword(body.password),
      role: invite.role,
    });
    // Losing the race means somebody else just spent this invite; the account
    // is removed again rather than left as an unexplained extra member.
    if (!consumeInvite(app.db, invite.id, user.id)) {
      deleteUser(app.db, user.id);
      reply.code(409).send({ error: 'invite_already_used' });
      return;
    }
    reply.code(201).send({ token: createSession(app.db, user.id), user: publicUser(user) });
  });

  /*
   * What an owner or admin may change about somebody else.
   *
   * Each of these refuses to remove the last owner: a server with nobody who
   * can administer it cannot be repaired from the inside.
   */
  app.patch('/api/v1/users/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { id } = request.params as { id: string };
    const body = UpdateUserBodySchema.parse(request.body);
    const target = getUserById(app.db, id);
    if (!target) {
      reply.code(404).send({ error: 'user_not_found' });
      return;
    }
    // Only an owner hands out administration, or hands over ownership.
    if ((body.role !== 'member' || target.role !== 'member') && request.user!.role !== 'owner') {
      reply.code(403).send({ error: 'owner_required' });
      return;
    }
    if (target.role === 'owner' && body.role !== 'owner' && countOwners(app.db) <= 1) {
      reply.code(409).send({ error: 'last_owner' });
      return;
    }
    reply.send(publicUser(setUserRole(app.db, id, body.role)!));
  });

  app.put('/api/v1/users/:id/suspension', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { id } = request.params as { id: string };
    const body = SuspensionBodySchema.parse(request.body);
    const target = getUserById(app.db, id);
    if (!target) {
      reply.code(404).send({ error: 'user_not_found' });
      return;
    }
    if (target.role === 'owner' && request.user!.role !== 'owner') {
      reply.code(403).send({ error: 'owner_required' });
      return;
    }
    if (body.suspended && target.role === 'owner' && countOwners(app.db) <= 1) {
      reply.code(409).send({ error: 'last_owner' });
      return;
    }
    reply.send(publicUser(setUserSuspended(app.db, id, body.suspended)!));
  });

  app.delete('/api/v1/users/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { id } = request.params as { id: string };
    const target = getUserById(app.db, id);
    if (!target) {
      reply.code(404).send({ error: 'user_not_found' });
      return;
    }
    if (target.role === 'owner' && request.user!.role !== 'owner') {
      reply.code(403).send({ error: 'owner_required' });
      return;
    }
    if (target.role === 'owner' && countOwners(app.db) <= 1) {
      reply.code(409).send({ error: 'last_owner' });
      return;
    }
    deleteUser(app.db, id);
    reply.code(204).send();
  });
}
