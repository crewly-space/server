import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getAgent } from '../agents/repository.js';
import { listConnectors } from '../connectors/service.js';
import type { ConnectorStatus } from '../connectors/providers.js';
import { listMcpServers } from '../mcp/repository.js';
import { hasPermission } from '../permissions/roles.js';
import { lastSuccessByConnection, listToolExecutions } from './audit.js';
import { buildToolCatalog, publicTool, toolsForAgent } from './catalog.js';
import { evaluateToolPolicy, forgetApprovals, listToolPolicies, replaceToolPolicies, SELECTOR_TYPES, type SelectorType } from './policy.js';
import { PROVIDER_PROFILES } from './providers.js';
import { searchTools } from './search.js';
import { TOOL_POLICY_MODES } from './types.js';

const manages = (app: FastifyInstance, request: FastifyRequest) => hasPermission(app.db, request.user!.id, 'integrations.manage');

function forbid(reply: FastifyReply): void {
  reply.code(403).send({ error: 'forbidden' });
}

/** An agent a user may look at the tools of: their own, or any when they manage integrations. */
function ownedAgent(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, agentId: string) {
  const agent = getAgent(app.db, agentId);
  if (!agent) { reply.code(404).send({ error: 'agent_not_found' }); return undefined; }
  if (agent.ownerUserId !== request.user!.id && !manages(app, request)) { forbid(reply); return undefined; }
  return agent;
}

const PolicySchema = z.object({
  selectorType: z.enum(SELECTOR_TYPES as [SelectorType, ...SelectorType[]]),
  selector: z.string().min(1).max(200),
  mode: z.enum(TOOL_POLICY_MODES),
});

export type ConnectionHealth = 'connected' | 'degraded' | 'expired' | 'error' | 'disabled' | 'pending';

function connectorHealth(status: ConnectorStatus): ConnectionHealth {
  switch (status) {
    case 'connected': return 'connected';
    case 'rate_limited': case 'provider_unavailable': return 'degraded';
    case 'permission_revoked': return 'expired';
    case 'revoked': return 'disabled';
    case 'pending': return 'pending';
    default: return 'error';
  }
}

export function registerToolRoutes(app: FastifyInstance): void {
  /** The normalized catalog: every tool every live connection offers. `q` searches it. */
  app.get('/api/v1/tools', { preHandler: requireAuth }, async (request, reply) => {
    if (!manages(app, request)) { forbid(reply); return; }
    const query = z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const catalog = buildToolCatalog(app.db);
    const tools = query.q ? searchTools(catalog, query.q, query.limit).map((hit) => hit.tool) : catalog;
    reply.send({ tools: tools.map(publicTool) });
  });

  /** What Crewly knows about each provider, with how many live connections each has. */
  app.get('/api/v1/tools/providers', { preHandler: requireAuth }, async (_request, reply) => {
    const counts = new Map<string, number>();
    for (const connector of listConnectors(app.db)) if (connector.status === 'connected') counts.set(connector.provider, (counts.get(connector.provider) ?? 0) + 1);
    const catalog = buildToolCatalog(app.db);
    for (const server of listMcpServers(app.db)) {
      const provider = catalog.find((tool) => tool.source.connectionId === server.id)?.provider ?? server.provider;
      if (provider && server.enabled) counts.set(provider, (counts.get(provider) ?? 0) + 1);
    }
    reply.send({ providers: PROVIDER_PROFILES.map(({ rules: _rules, resourceAliases: _aliases, hosts: _hosts, ...profile }) => ({
      ...profile, connections: counts.get(profile.id) ?? 0,
    })) });
  });

  /** Every tool an agent has, and what happens when it calls each. */
  app.get('/api/v1/agents/:id/tool-access', { preHandler: requireAuth }, async (request, reply) => {
    const agent = ownedAgent(app, request, reply, (request.params as { id: string }).id);
    if (!agent) return;
    const tools = toolsForAgent(app.db, agent.id).map((tool) => {
      const decision = evaluateToolPolicy(app.db, agent.id, tool);
      return { tool: publicTool(tool), skillId: tool.skillId, mode: decision.mode, reason: decision.reason, exposed: !tool.schemaIssues && decision.mode !== 'blocked' };
    });
    reply.send({ tools });
  });

  /** Forget "ask once" approvals, so the agent asks again. */
  app.delete('/api/v1/agents/:id/tool-approvals', { preHandler: requireAuth }, async (request, reply) => {
    const agent = ownedAgent(app, request, reply, (request.params as { id: string }).id);
    if (!agent) return;
    const { tool } = z.object({ tool: z.string().max(200).optional() }).parse(request.query);
    forgetApprovals(app.db, agent.id, tool);
    reply.code(204).send();
  });

  app.get('/api/v1/tool-policies', { preHandler: requireAuth }, async (request, reply) => {
    const { agentId } = z.object({ agentId: z.string().min(1).max(200).optional() }).parse(request.query);
    if (agentId) {
      if (!ownedAgent(app, request, reply, agentId)) return;
      reply.send({ policies: listToolPolicies(app.db, agentId), workspace: listToolPolicies(app.db, null) });
      return;
    }
    reply.send({ policies: listToolPolicies(app.db, null), workspace: listToolPolicies(app.db, null) });
  });

  /**
   * Replaces the rules for one agent, or for the workspace (agentId null).
   * Workspace rules need integrations.manage. An agent's owner may make their
   * agent stricter -- ask every time, or block -- but only an admin can let
   * it act without asking.
   */
  app.put('/api/v1/tool-policies', { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({ agentId: z.string().min(1).max(200).nullable(), policies: z.array(PolicySchema).max(500) }).parse(request.body);
    const admin = manages(app, request);
    if (body.agentId === null) {
      if (!admin) { forbid(reply); return; }
    } else {
      if (!ownedAgent(app, request, reply, body.agentId)) return;
      const loosening = body.policies.find((policy) => policy.mode === 'always' || policy.mode === 'ask_once');
      if (loosening && !admin) {
        reply.code(403).send({ error: 'loosening_requires_admin', message: 'Only an admin can let an agent use a tool without asking every time.' });
        return;
      }
    }
    reply.send({ policies: replaceToolPolicies(app.db, body.agentId, body.policies, request.user!.id) });
  });

  /** The audit log of tool executions. People who do not manage integrations see their own agents'. */
  app.get('/api/v1/tool-executions', { preHandler: requireAuth }, async (request, reply) => {
    const query = z.object({
      agentId: z.string().max(200).optional(), connectionId: z.string().max(200).optional(), runId: z.string().max(200).optional(),
      status: z.enum(['success', 'error', 'blocked', 'approval_required']).optional(), tool: z.string().max(200).optional(),
      before: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(request.query);
    const agentIds = manages(app, request) ? undefined
      : (app.db.prepare('SELECT id FROM agents WHERE owner_user_id = ?').pluck().all(request.user!.id) as string[]);
    reply.send({ executions: listToolExecutions(app.db, { ...query, toolRef: query.tool, agentIds }) });
  });

  /** Every connection -- native and MCP -- with one health vocabulary. */
  app.get('/api/v1/connections', { preHandler: requireAuth }, async (request, reply) => {
    if (!manages(app, request)) { forbid(reply); return; }
    const lastSuccess = lastSuccessByConnection(app.db);
    const catalog = buildToolCatalog(app.db);
    const toolCount = (id: string) => catalog.filter((tool) => tool.source.connectionId === id).length;
    const connectors = listConnectors(app.db).map((connector) => ({
      kind: 'connector' as const, id: connector.id, name: connector.accountName ? `${connector.provider} · ${connector.accountName}` : connector.provider,
      provider: connector.provider, status: connectorHealth(connector.status), trust: 'official' as const,
      account: connector.accountName, scopes: connector.scopes, tokenExpiresAt: null,
      lastSuccessAt: lastSuccess.get(connector.id) ?? connector.lastUsedAt, lastError: connector.lastError, lastCheckedAt: connector.lastCheckedAt,
      toolsAvailable: toolCount(connector.id),
    }));
    const servers = listMcpServers(app.db).map((server) => ({
      kind: 'mcp_server' as const, id: server.id, name: server.name,
      provider: catalog.find((tool) => tool.source.connectionId === server.id)?.provider ?? server.provider,
      status: (server.enabled ? (server.health === 'unknown' ? 'pending' : server.health) : 'disabled') as ConnectionHealth, trust: server.trust,
      account: server.serverInfo.name ?? null, scopes: server.oauth?.scope ? server.oauth.scope.split(' ') : [],
      tokenExpiresAt: server.oauth?.expiresAt ?? null,
      lastSuccessAt: server.lastSuccessAt, lastError: server.lastError, lastCheckedAt: server.lastTestedAt,
      toolsAvailable: toolCount(server.id),
    }));
    reply.send({ connections: [...connectors, ...servers] });
  });
}
