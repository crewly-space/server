import type { Database } from '../db/driver.js';
import type { AgentToolset, ToolsetProvider } from '../providers/respond.js';
import {
  findSecretReferences,
  registerGranteeNamer,
  registerSecretReferenceScanner,
  resolveSecretReferences,
  SecretAccessError,
  type Grantee,
} from '../secrets/vault.js';
import { callMcpTool, discoverMcpTools, McpError, type McpClientOptions, type McpToolInfo, type McpTransportConfig } from './client.js';
import { getMcpServer, listAgentTools, listMcpServers, recordDiscovery, type McpServerRecord } from './repository.js';

/** What stands in for a literal credential when a server's config is shown. */
export const REDACTED = '••••••';

function grantee(server: Pick<McpServerRecord, 'id'>): Grantee {
  return { type: 'mcp_server', id: server.id };
}

/**
 * The server's connection settings with every {{secret:NAME}} filled in --
 * only secrets granted to this MCP server resolve, and each read is audited.
 */
export function resolveTransport(db: Database, server: McpServerRecord): McpTransportConfig {
  const fill = (value: string) => resolveSecretReferences(db, value, grantee(server));
  const fillAll = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, fill(value)]));
  if (server.transport === 'http') {
    return { transport: 'http', url: fill(server.url!), headers: fillAll(server.headers) };
  }
  return { transport: 'stdio', command: server.command!, args: server.args.map(fill), env: fillAll(server.env) };
}

function explain(error: unknown): { code: string; message: string } {
  if (error instanceof McpError) return { code: error.code, message: error.message };
  if (error instanceof SecretAccessError) return { code: 'secret_unavailable', message: `${error.message}. Grant it to this MCP server in Secrets.` };
  return { code: 'mcp_failed', message: error instanceof Error ? error.message : String(error) };
}

/** Connects, discovers tools, and records what happened -- the "Test connection" button. */
export async function testMcpServer(
  db: Database,
  server: McpServerRecord,
  options: McpClientOptions,
): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: { code: string; message: string } }> {
  try {
    const tools = await discoverMcpTools(resolveTransport(db, server), options);
    recordDiscovery(db, server.id, { tools });
    return { ok: true, tools };
  } catch (error) {
    const failure = explain(error);
    recordDiscovery(db, server.id, { error: failure.message });
    return { ok: false, error: failure };
  }
}

/**
 * Whether a header or env value is safe to show: it is, when everything in it
 * apart from secret references is empty or a bare auth scheme ("Bearer").
 * Anything else may be a pasted credential, so it is masked -- conservatively,
 * a harmless literal like `production` is masked too.
 */
function showable(value: string): boolean {
  const literal = value.replace(/\{\{\s*secret:[A-Z][A-Z0-9_]*\s*\}\}/g, '').trim();
  return literal === '' || /^(bearer|basic|token|bot)$/i.test(literal);
}

function redactValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, showable(value) ? value : REDACTED]));
}

export function publicMcpServer(server: McpServerRecord) {
  return {
    ...server,
    headers: redactValues(server.headers),
    env: redactValues(server.env),
    availableTools: server.tools.filter((tool) => !server.disabledTools.includes(tool.name)).map((tool) => tool.name),
  };
}

/** A PATCH that sends a masked value back means "keep what is there". */
export function mergeRedacted(incoming: Record<string, string> | undefined, existing: Record<string, string>): Record<string, string> | undefined {
  if (!incoming) return undefined;
  return Object.fromEntries(Object.entries(incoming).map(([key, value]) => [key, value === REDACTED ? existing[key] ?? '' : value]));
}

/** How a tool appears to a model: unique across servers, within the 64 characters providers allow. */
export function exposedToolName(server: Pick<McpServerRecord, 'name'>, tool: string): string {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `mcp_${slug(server.name).slice(0, 20)}_${slug(tool)}`.slice(0, 64);
}

/**
 * The MCP tools an agent was given, as a toolset for its turns. A tool is
 * offered only while its server is enabled, the tool was discovered and is
 * not switched off, and the assignment still covers every capability the
 * server declares -- so declaring a new capability withdraws the tool until
 * someone acknowledges it again.
 */
export function mcpToolset(db: Database, options: McpClientOptions): ToolsetProvider {
  return (agent): AgentToolset | undefined => {
    const assignments = listAgentTools(db, agent.id);
    if (assignments.length === 0) return undefined;
    const servers = new Map<string, McpServerRecord | undefined>();
    const byName = new Map<string, { server: McpServerRecord; tool: McpToolInfo }>();
    for (const assignment of assignments) {
      if (!servers.has(assignment.serverId)) servers.set(assignment.serverId, getMcpServer(db, assignment.serverId));
      const server = servers.get(assignment.serverId);
      if (!server?.enabled || server.disabledTools.includes(assignment.toolName)) continue;
      if (!server.capabilities.every((capability) => assignment.grantedCapabilities.includes(capability))) continue;
      const tool = server.tools.find((candidate) => candidate.name === assignment.toolName);
      if (!tool) continue;
      byName.set(exposedToolName(server, tool.name), { server, tool });
    }
    if (byName.size === 0) return undefined;

    return {
      definitions: [...byName].map(([name, { server, tool }]) => ({
        name,
        description: `${tool.description || tool.name} (from ${server.name})`.slice(0, 1024),
        inputSchema: tool.inputSchema,
      })),
      async execute(call) {
        const entry = byName.get(call.name);
        if (!entry) return { content: `There is no tool called "${call.name}".`, isError: true };
        try {
          const result = await callMcpTool(resolveTransport(db, entry.server), entry.tool.name, call.input, options);
          return { content: result.text || '(no output)', isError: result.isError };
        } catch (error) {
          return { content: explain(error).message, isError: true };
        }
      },
    };
  };
}

let registered = false;

/** Lets the secrets vault see which MCP servers refer to a secret, and name them. */
export function registerMcpSecretHooks(): void {
  if (registered) return;
  registered = true;
  registerSecretReferenceScanner((db, secretName) =>
    listMcpServers(db)
      .filter((server) =>
        [server.url ?? '', ...server.args, ...Object.values(server.headers), ...Object.values(server.env)]
          .some((value) => findSecretReferences(value).includes(secretName)))
      .map((server) => ({ type: 'mcp_server', id: server.id, name: server.name, via: 'reference' as const })));
  registerGranteeNamer('mcp_server', (db, id) => getMcpServer(db, id)?.name);
}
