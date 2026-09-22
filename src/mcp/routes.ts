import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getAgent } from '../agents/repository.js';
import type { McpClientOptions } from './client.js';
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listAgentTools,
  listMcpServers,
  MCP_CAPABILITIES,
  setAgentTools,
  setDisabledTools,
  updateMcpServer,
  type McpCapability,
} from './repository.js';
import { mergeRedacted, publicMcpServer, testMcpServer } from './service.js';

const CapabilitySchema = z.enum(MCP_CAPABILITIES as [McpCapability, ...McpCapability[]]);
const ValuesSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), z.string().max(8192));

const ServerBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  transport: z.enum(['http', 'stdio']),
  url: z.string().url().max(2048).optional(),
  command: z.string().min(1).max(1024).optional(),
  args: z.array(z.string().max(4096)).max(64).optional(),
  headers: ValuesSchema.optional(),
  env: ValuesSchema.optional(),
  capabilities: z.array(CapabilitySchema).optional(),
  enabled: z.boolean().optional(),
});

const CreateServerSchema = ServerBodySchema.superRefine((body, ctx) => {
  if (body.transport === 'http' && !body.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'An HTTP MCP server needs a url' });
  if (body.transport === 'stdio' && !body.command) ctx.addIssue({ code: 'custom', path: ['command'], message: 'A local MCP server needs a command' });
  if (body.transport === 'http' && body.url && !/^https?:\/\//.test(body.url)) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'Use an http or https URL' });
  }
});

const DisabledToolsSchema = z.object({ disabled: z.array(z.string().min(1)).max(500) });

const AgentToolsSchema = z.object({
  tools: z.array(z.object({ serverId: z.string().min(1), toolName: z.string().min(1) })).max(200),
  /** The capabilities whoever assigns the tools accepts on the agent's behalf. */
  acknowledgeCapabilities: z.array(CapabilitySchema).default([]),
});

function isAdmin(request: FastifyRequest): boolean {
  return request.user!.role === 'owner' || request.user!.role === 'admin';
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isAdmin(request)) return true;
  reply.code(403).send({ error: 'forbidden' });
  return false;
}

/**
 * MCP servers and who may use their tools.
 *
 * Connecting a server is an admin's job. Giving an agent a tool is too, with
 * one exception: an agent's owner may give it tools from a server that
 * declares no shell, filesystem or network capability.
 */
export function registerMcpRoutes(app: FastifyInstance, clientOptions: McpClientOptions): void {
  app.get('/api/v1/mcp-servers', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    reply.send({ servers: listMcpServers(app.db).map(publicMcpServer) });
  });

  app.post('/api/v1/mcp-servers', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const body = CreateServerSchema.parse(request.body);
    if (listMcpServers(app.db).some((server) => server.name.toLowerCase() === body.name.toLowerCase())) {
      reply.code(409).send({ error: 'mcp_server_exists' });
      return;
    }
    reply.code(201).send(publicMcpServer(createMcpServer(app.db, body)));
  });

  app.patch('/api/v1/mcp-servers/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    const existing = getMcpServer(app.db, id);
    if (!existing) {
      reply.code(404).send({ error: 'mcp_server_not_found' });
      return;
    }
    const body = ServerBodySchema.partial().parse(request.body);
    const updated = updateMcpServer(app.db, id, {
      ...body,
      headers: mergeRedacted(body.headers, existing.headers),
      env: mergeRedacted(body.env, existing.env),
    });
    reply.send(publicMcpServer(updated!));
  });

  app.delete('/api/v1/mcp-servers/:id', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!deleteMcpServer(app.db, id)) {
      reply.code(404).send({ error: 'mcp_server_not_found' });
      return;
    }
    reply.code(204).send();
  });

  /** Connects, lists its tools, and says plainly what went wrong if it could not. */
  app.post('/api/v1/mcp-servers/:id/test', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    const server = getMcpServer(app.db, id);
    if (!server) {
      reply.code(404).send({ error: 'mcp_server_not_found' });
      return;
    }
    const outcome = await testMcpServer(app.db, server, clientOptions);
    reply.send({ ...outcome, server: publicMcpServer(getMcpServer(app.db, id)!) });
  });

  app.put('/api/v1/mcp-servers/:id/tools', { preHandler: requireAuth }, async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    if (!getMcpServer(app.db, id)) {
      reply.code(404).send({ error: 'mcp_server_not_found' });
      return;
    }
    setDisabledTools(app.db, id, DisabledToolsSchema.parse(request.body).disabled);
    reply.send(publicMcpServer(getMcpServer(app.db, id)!));
  });

  app.get('/api/v1/agents/:id/tools', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = getAgent(app.db, id);
    if (!agent) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    reply.send({ tools: listAgentTools(app.db, id) });
  });

  app.put('/api/v1/agents/:id/tools', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = getAgent(app.db, id);
    if (!agent) {
      reply.code(404).send({ error: 'agent_not_found' });
      return;
    }
    const admin = isAdmin(request);
    if (!admin && agent.ownerUserId !== request.user!.id) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const body = AgentToolsSchema.parse(request.body);
    const assignments: Array<{ serverId: string; toolName: string; grantedCapabilities: McpCapability[] }> = [];
    for (const tool of body.tools) {
      const server = getMcpServer(app.db, tool.serverId);
      if (!server) {
        reply.code(400).send({ error: 'mcp_server_not_found', serverId: tool.serverId });
        return;
      }
      if (!server.tools.some((known) => known.name === tool.toolName)) {
        reply.code(400).send({ error: 'unknown_tool', message: `${server.name} has no tool "${tool.toolName}". Test the connection to refresh its tools.` });
        return;
      }
      if (server.capabilities.length && !admin) {
        reply.code(403).send({
          error: 'capability_requires_admin',
          message: `${server.name} can use ${server.capabilities.join(', ')}; only an admin can give its tools to an agent.`,
        });
        return;
      }
      const missing = server.capabilities.filter((capability) => !body.acknowledgeCapabilities.includes(capability));
      if (missing.length) {
        reply.code(400).send({
          error: 'capabilities_not_acknowledged',
          message: `${server.name} can use ${missing.join(', ')}. Acknowledge that to give its tools to an agent.`,
          capabilities: missing,
        });
        return;
      }
      assignments.push({ ...tool, grantedCapabilities: server.capabilities });
    }
    setAgentTools(app.db, id, assignments);
    reply.send({ tools: listAgentTools(app.db, id) });
  });
}
