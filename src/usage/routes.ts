import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getAgent } from '../agents/repository.js';
import {
  budgetStatus,
  createBudget,
  deleteBudget,
  getBudget,
  listBudgets,
  updateBudget,
} from './budgets.js';
import { deleteModelPrice, listModelPrices, setModelPrice } from './pricing.js';
import { exportProviderCalls, usageReport } from './report.js';

const MICROS_PER_USD = 1_000_000;

const UsageQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  groupBy: z.enum(['agent', 'provider', 'model', 'day']).default('agent'),
  agentId: z.string().min(1).optional(),
});

const ExportQuerySchema = z.object({
  after: z.string().max(200).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(500),
});

const BudgetBodySchema = z.object({
  scope: z.enum(['server', 'agent']),
  agentId: z.string().min(1).optional(),
  period: z.enum(['daily', 'monthly']),
  limitUsd: z.number().positive().max(1_000_000),
  action: z.enum(['warn', 'block', 'fallback']).default('warn'),
}).refine((body) => (body.scope === 'agent') === Boolean(body.agentId), {
  message: 'agentId is required for an agent budget, and only for one',
  path: ['agentId'],
});

const BudgetPatchSchema = z.object({
  limitUsd: z.number().positive().max(1_000_000).optional(),
  action: z.enum(['warn', 'block', 'fallback']).optional(),
});

const PriceBodySchema = z.object({
  providerKind: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  inputPerMTokUsd: z.number().min(0).max(10_000),
  outputPerMTokUsd: z.number().min(0).max(10_000),
});

function isAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const role = request.user!.role;
  if (role === 'owner' || role === 'admin') return true;
  reply.code(403).send({ error: 'forbidden' });
  return false;
}

const withUsd = <T extends { limitMicros: number; spentMicros?: number }>(budget: T) => ({
  ...budget,
  limitUsd: budget.limitMicros / MICROS_PER_USD,
  ...(budget.spentMicros !== undefined ? { spentUsd: budget.spentMicros / MICROS_PER_USD } : {}),
});

/**
 * Spend visibility and control for the people who run a server. Everything is
 * owner/admin only: what the server spends is theirs to see and to limit.
 */
export function registerUsageRoutes(app: FastifyInstance): void {
  app.get('/api/v1/usage', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    const query = UsageQuerySchema.parse(request.query);
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    reply.send(usageReport(app.db, { from, to, groupBy: query.groupBy, agentId: query.agentId }));
  });

  app.get('/api/v1/usage/calls', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    reply.send(exportProviderCalls(app.db, ExportQuerySchema.parse(request.query)));
  });

  app.get('/api/v1/usage/prices', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    reply.send({ prices: listModelPrices(app.db) });
  });

  app.put('/api/v1/usage/prices', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    reply.send(setModelPrice(app.db, PriceBodySchema.parse(request.body)));
  });

  app.delete('/api/v1/usage/prices/:providerKind/:model', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    const { providerKind, model } = request.params as { providerKind: string; model: string };
    if (!deleteModelPrice(app.db, providerKind, decodeURIComponent(model))) {
      reply.code(404).send({ error: 'price_not_found' });
      return;
    }
    reply.code(204).send();
  });

  app.get('/api/v1/budgets', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    reply.send({ budgets: listBudgets(app.db).map((budget) => withUsd(budgetStatus(app.db, budget))) });
  });

  app.post('/api/v1/budgets', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    const body = BudgetBodySchema.parse(request.body);
    if (body.agentId && !getAgent(app.db, body.agentId)) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    try {
      const budget = createBudget(app.db, {
        scope: body.scope,
        agentId: body.agentId,
        period: body.period,
        limitMicros: Math.round(body.limitUsd * MICROS_PER_USD),
        action: body.action,
        createdBy: request.user!.id,
      });
      reply.code(201).send(withUsd(budgetStatus(app.db, budget)));
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) {
        reply.code(409).send({ error: 'budget_exists', message: 'There is already a budget for that scope and period' });
        return;
      }
      throw error;
    }
  });

  app.patch('/api/v1/budgets/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = BudgetPatchSchema.parse(request.body);
    const budget = updateBudget(app.db, id, {
      limitMicros: body.limitUsd === undefined ? undefined : Math.round(body.limitUsd * MICROS_PER_USD),
      action: body.action,
    });
    if (!budget) {
      reply.code(404).send({ error: 'budget_not_found' });
      return;
    }
    reply.send(withUsd(budgetStatus(app.db, budget)));
  });

  app.delete('/api/v1/budgets/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!getBudget(app.db, id) || !deleteBudget(app.db, id)) {
      reply.code(404).send({ error: 'budget_not_found' });
      return;
    }
    reply.code(204).send();
  });
}
