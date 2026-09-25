import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { emitNotification } from '../notifications/service.js';
import { hashPassword } from '../auth/password.js';
import { createSession } from '../auth/session.js';
import { verifySessionToken } from '../auth/session.js';
import {
  consumeInvite,
  createInvite,
  findPendingInviteFor,
  findUsableInvite,
  getInvite,
  listInvites,
  normaliseEmail,
  pruneExpiredInvites,
  renewInvite,
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
  updateOwnProfile,
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
  /** Who the invite is for. Only this address can accept it. */
  email: z.string().email().max(320).optional(),
  /** Also send it to `email` through the server's mail provider. Defaults to on when an email is given. */
  send: z.boolean().optional(),
}).transform((body) => ({ ...body, send: body.send ?? Boolean(body.email) }));

const AcceptInviteBodySchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(100),
  password: z.string().min(12).max(256),
});

const UpdateUserBodySchema = z.object({ role: z.enum(['owner', 'admin', 'member']) });
const UpdateProfileBodySchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  avatarMode: z.enum(['bloop', 'blobatar', 'name']).optional(),
});
const SuspensionBodySchema = z.object({ suspended: z.boolean() });

function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
    suspendedAt: user.suspended_at ?? null,
    avatarMode: user.avatar_mode ?? 'bloop',
  };
}

/** What anyone on the server may know about anyone else: enough to draw them. */
function directoryEntry(user: UserRow) {
  return { id: user.id, displayName: user.display_name, avatarMode: user.avatar_mode ?? 'bloop' };
}

const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/** Whoever this bearer token signs in, if anyone; a suspended account is nobody. */
function sessionUserFrom(app: FastifyInstance, header: string | undefined): UserRow | undefined {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const userId = token ? verifySessionToken(app.db, token) : undefined;
  const user = userId ? getUserById(app.db, userId) : undefined;
  return user && !user.suspended_at ? user : undefined;
}

function canManageUsers(role: string): role is Extract<Role, 'owner' | 'admin'> {
  return role === 'owner' || role === 'admin';
}

export function registerUserRoutes(app: FastifyInstance): void {
  const sessionUser = (header: string | undefined) => sessionUserFrom(app, header);
  app.get('/api/v1/users', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    reply.send(listUsers(app.db).map(publicUser));
  });

  /*
   * Everyone on the server, as a conversation shows them: name and avatar.
   *
   * Members cannot list users -- emails and roles are for whoever administers
   * the server -- but they still see other people's messages, and have to be
   * able to draw who wrote them.
   */
  app.get('/api/v1/users/directory', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send({ users: listUsers(app.db).filter((user) => !user.suspended_at).map(directoryEntry) });
  });

  /** A person's own name and avatar. Anyone may change their own; nobody else's. */
  app.patch('/api/v1/users/me', { preHandler: requireAuth }, async (request, reply) => {
    const body = UpdateProfileBodySchema.parse(request.body);
    reply.send(publicUser(updateOwnProfile(app.db, request.user!.id, body)!));
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
   * invite is a link they redeem with a password only they ever know -- or,
   * when they already have an account, by signing in and accepting.
   */
  const sendInviteEmail = async (
    request: { protocol: string; headers: { host?: string } },
    invite: { id: string; role: string },
    email: string,
    code: string,
  ) => {
    // A failed send is a delivery to inspect, not a failed invite: the code
    // still works when handed over another way.
    const delivered = await emitNotification(app.db, {
      type: 'member.invited',
      recipients: [{ email }],
      // A resend is a new message, not a duplicate of the first.
      dedupeKey: `invite:${invite.id}:${code.slice(0, 8)}`,
      title: 'You are invited',
      body: 'You have been invited to a Crewly server.',
      template: {
        id: 'member.invited',
        variables: { inviteUrl: `${request.protocol}://${request.headers.host}/join#invite=${code}`, role: invite.role },
      },
    });
    const mailDeliveryId = delivered.find((entry) => entry.channel === 'email')?.mailDeliveryId;
    return mailDeliveryId ? app.mail.getDelivery(mailDeliveryId) : undefined;
  };

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
    const email = body.email ? normaliseEmail(body.email) : undefined;
    if (email) {
      // One person, one way in: somebody already here needs no invite, and a
      // second invite would leave two live links for the same person.
      if (getUserByEmail(app.db, email)) {
        reply.code(409).send({ error: 'already_member', message: `${email} is already a member of this server.` });
        return;
      }
      const pending = findPendingInviteFor(app.db, email);
      if (pending) {
        reply.code(409).send({
          error: 'invite_pending',
          message: `${email} already has a pending invite. Resend it instead.`,
          inviteId: pending.id,
        });
        return;
      }
    }
    // Checked before the invite exists, so asking for an email that cannot be sent creates nothing.
    if (email && body.send && !app.mail.enabled()) {
      reply.code(409).send({ error: 'mail_disabled', message: 'Outbound email is disabled on this server' });
      return;
    }
    const { invite, code } = createInvite(app.db, {
      role: body.role,
      createdBy: request.user!.id,
      label: body.label ?? null,
      email: email ?? null,
    });
    const delivery = email && body.send ? await sendInviteEmail(request, invite, email, code) : undefined;
    // The only time the code is ever returned: it is stored hashed, so nothing
    // can read it back afterwards.
    reply.code(201).send({ invite: { ...invite, code }, ...(delivery ? { delivery } : {}) });
  });

  app.get('/api/v1/invites', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    pruneExpiredInvites(app.db);
    reply.send({ invites: listInvites(app.db) });
  });

  /** A new code and a fresh week, emailed again when the invite names someone and mail works. */
  app.post('/api/v1/invites/:id/resend', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { id } = request.params as { id: string };
    const existing = getInvite(app.db, id);
    if (!existing) {
      reply.code(404).send({ error: 'invite_not_found' });
      return;
    }
    if (existing.role === 'admin' && request.user!.role !== 'owner') {
      reply.code(403).send({ error: 'owner_required_for_admin' });
      return;
    }
    const renewed = renewInvite(app.db, id);
    if (!renewed) {
      reply.code(409).send({ error: 'invite_closed', message: `This invite was already ${existing.status}.` });
      return;
    }
    const delivery = renewed.invite.email && app.mail.enabled()
      ? await sendInviteEmail(request, renewed.invite, renewed.invite.email, renewed.code)
      : undefined;
    reply.send({ invite: { ...renewed.invite, code: renewed.code }, ...(delivery ? { delivery } : {}) });
  });

  app.delete('/api/v1/invites/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!canManageUsers(request.user!.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const { id } = request.params as { id: string };
    const existing = getInvite(app.db, id);
    if (!existing) {
      reply.code(404).send({ error: 'invite_not_found' });
      return;
    }
    if (!revokeInvite(app.db, id)) {
      reply.code(409).send({ error: 'invite_closed', message: `This invite was already ${existing.status}.` });
      return;
    }
    reply.code(204).send();
  });

  /*
   * What an invite link is for, so the page it opens can say so before anyone
   * types a password. Unauthenticated, like accepting: the code is the key.
   */
  app.get('/api/v1/invites/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    const invite = findUsableInvite(app.db, code);
    if (!invite) {
      reply.code(404).send({ error: 'invite_not_found', message: 'This invite has expired, was revoked, or was already used.' });
      return;
    }
    reply.send({ role: invite.role, email: invite.email, expiresAt: invite.expiresAt });
  });

  /*
   * Redeeming one. Deliberately open: the code is the credential, and the
   * person holding it may have no account here yet. Somebody who is signed in
   * accepts as themselves instead, and keeps their account and password.
   */
  app.post('/api/v1/invites/:code/accept', async (request, reply) => {
    const { code } = request.params as { code: string };
    const invite = findUsableInvite(app.db, code);
    // Used, revoked, expired and never-existed all answer alike: none of them
    // is something the holder can act on.
    if (!invite) {
      reply.code(404).send({ error: 'invite_not_found', message: 'This invite has expired, was revoked, or was already used.' });
      return;
    }
    const signedIn = sessionUser(request.headers.authorization);
    if (signedIn) {
      if (invite.email && invite.email !== normaliseEmail(signedIn.email)) {
        reply.code(403).send({
          error: 'invite_email_mismatch',
          message: `This invite is for ${invite.email}. Sign in with that account to accept it.`,
        });
        return;
      }
      if (!consumeInvite(app.db, invite.id, signedIn.id)) {
        reply.code(409).send({ error: 'invite_already_used' });
        return;
      }
      // An invite can raise somebody's access, never lower it.
      const role: Role = ROLE_RANK[invite.role] > ROLE_RANK[signedIn.role] ? invite.role : signedIn.role;
      const user = role === signedIn.role ? signedIn : setUserRole(app.db, signedIn.id, role)!;
      reply.code(200).send({ token: request.headers.authorization!.slice(7), user: publicUser(user) });
      return;
    }
    const body = AcceptInviteBodySchema.parse(request.body);
    const email = normaliseEmail(body.email);
    if (invite.email && invite.email !== email) {
      reply.code(403).send({ error: 'invite_email_mismatch', message: `This invite is for ${invite.email}.` });
      return;
    }
    if (getUserByEmail(app.db, email)) {
      reply.code(409).send({
        error: 'user_exists',
        message: 'You already have an account here. Sign in, then open the invite link again.',
      });
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
