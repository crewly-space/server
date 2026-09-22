import type { FastifyReply, FastifyRequest } from 'fastify';
import { getUserById } from '../users/repository.js';
import { verifySessionToken } from './session.js';

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  const userId = verifySessionToken(request.server.db, token);
  if (!userId) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  const user = getUserById(request.server.db, userId);
  // A suspended account is not an account that can act, whatever token it
  // still holds.
  if (!user || user.suspended_at) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  request.user = { id: user.id, role: user.role };
}
