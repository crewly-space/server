import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { countUsers, createUser, getUserByEmail, getUserById } from '../users/repository.js';
import { requireAuth } from './middleware.js';
import { hashPassword, verifyPassword } from './password.js';
import { createSession, revokeSession } from './session.js';

const SetupBodySchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(12).max(256),
  claimToken: z.string().min(1).optional(),
});

const LoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  options: { setupClaimToken?: string; onSetupComplete?: () => void } = {},
): void {
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_ATTEMPTS = 20;
  /** Sweep above this many tracked addresses, so the map cannot grow forever. */
  const SWEEP_THRESHOLD = 1024;
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const checkRateLimit = (ip: string): void => {
    const now = Date.now();
    // Only a successful login clears an address, so expired windows would
    // otherwise accumulate for every address that ever failed.
    if (attempts.size > SWEEP_THRESHOLD) {
      for (const [address, window] of attempts) {
        if (window.resetAt <= now) attempts.delete(address);
      }
    }
    const current = attempts.get(ip);
    const next = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + WINDOW_MS }
      : { count: current.count + 1, resetAt: current.resetAt };
    attempts.set(ip, next);
    if (next.count > MAX_ATTEMPTS) {
      const error = new Error('too_many_attempts') as Error & { statusCode: number };
      error.statusCode = 429;
      throw error;
    }
  };
  app.get('/api/v1/auth/status', async () => {
    const initialized = countUsers(app.db) > 0;
    return { initialized, claimRequired: !initialized && Boolean(options.setupClaimToken) };
  });
  app.post('/api/v1/auth/setup', async (request, reply) => {
    checkRateLimit(request.ip);
    if (countUsers(app.db) > 0) {
      reply.code(409).send({ error: 'already_initialized' });
      return;
    }
    const body = SetupBodySchema.parse(request.body);
    if (options.setupClaimToken && !sameSecret(body.claimToken, options.setupClaimToken)) {
      reply.code(403).send({ error: 'invalid_claim_token' });
      return;
    }
    const user = createUser(app.db, {
      email: body.email.trim().toLowerCase(),
      displayName: body.displayName,
      passwordHash: hashPassword(body.password),
      role: 'owner',
    });
    const token = createSession(app.db, user.id);
    options.onSetupComplete?.();
    reply.code(201).send({ token, user: { id: user.id, email: user.email, role: user.role } });
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    checkRateLimit(request.ip);
    const body = LoginBodySchema.parse(request.body);
    const user = getUserByEmail(app.db, body.email.trim());
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      reply.code(401).send({ error: 'invalid_credentials' });
      return;
    }
    const token = createSession(app.db, user.id);
    attempts.delete(request.ip);
    reply.code(200).send({ token, user: { id: user.id, email: user.email, role: user.role } });
  });

  app.get('/api/v1/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = getUserById(app.db, request.user!.id)!;
    reply.send({ id: user.id, email: user.email, role: user.role });
  });
  app.post('/api/v1/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    revokeSession(app.db, request.headers.authorization!.slice(7));
    reply.code(204).send();
  });
}

function sameSecret(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
