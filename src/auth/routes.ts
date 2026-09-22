import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { countUsers, createUser, getUserByEmail, getUserById } from '../users/repository.js';
import { requireAuth } from './middleware.js';
import { hashPassword, verifyPassword } from './password.js';
import { createSession, revokeSession } from './session.js';
import {
  applyHandoff,
  consumeNonce,
  HandoffRejected,
  verifyHandoffToken,
  type CloudHandoffConfig,
} from './cloud-handoff.js';

const SetupBodySchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(12).max(256),
  claimToken: z.string().min(1).optional(),
});

const HandoffBodySchema = z.object({
  token: z.string().min(1).max(4096),
});

const LoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  options: {
    setupClaimToken?: string;
    onSetupComplete?: () => void;
    cloudHandoff?: CloudHandoffConfig;
  } = {},
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
    return {
      initialized,
      claimRequired: !initialized && Boolean(options.setupClaimToken),
      // Tells the app whether to offer a Cloud sign-in or only the local form.
      cloudHandoff: Boolean(options.cloudHandoff),
    };
  });

  /*
   * Signing in with the Crewly account that owns this server.
   *
   * Only registered when an operator has linked the server to a Cloud: a
   * self-hosted server has no such key, so it has no such door either. The
   * token is the whole authentication, so every reason to refuse one answers
   * the same way -- a caller learns whether it worked and nothing else.
   */
  if (options.cloudHandoff) {
    const handoff = options.cloudHandoff;
    app.post('/api/v1/auth/cloud-handoff', async (request, reply) => {
      checkRateLimit(request.ip);
      const body = HandoffBodySchema.parse(request.body);
      let claims;
      try {
        claims = verifyHandoffToken(body.token, handoff);
      } catch (error) {
        if (error instanceof HandoffRejected) {
          request.log.warn({ reason: error.message }, 'cloud handoff refused');
          reply.code(401).send({ error: 'invalid_handoff' });
          return;
        }
        throw error;
      }
      if (!consumeNonce(app.db, claims.nonce, new Date(claims.exp * 1000))) {
        reply.code(401).send({ error: 'invalid_handoff' });
        return;
      }
      const user = applyHandoff(app.db, claims, options.onSetupComplete);
      // Same answer the password form gives: a session here would only be
      // refused on its first request, and the app could not say why.
      if (user.suspended_at) {
        reply.code(403).send({ error: 'account_suspended' });
        return;
      }
      const token = createSession(app.db, user.id);
      reply.code(201).send({ token, user: { id: user.id, email: user.email, role: user.role } });
    });
  }
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
    // An account that only exists through Cloud has no password to check, and
    // an empty one must never be treated as a match.
    if (!user || !user.password_hash || !verifyPassword(body.password, user.password_hash)) {
      reply.code(401).send({ error: 'invalid_credentials' });
      return;
    }
    // Said plainly: somebody whose access was withdrawn should be told that,
    // not left guessing at their own password.
    if (user.suspended_at) {
      reply.code(403).send({ error: 'account_suspended' });
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
