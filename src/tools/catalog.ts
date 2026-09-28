import type { Database } from '../db/driver.js';
import { listConnectors, type ConnectorView } from '../connectors/service.js';
import type { ConnectorCapability } from '../connectors/providers.js';
import { listMcpServers, type McpServerRecord } from '../mcp/repository.js';
import { classifyTool, snakeCase } from './classify.js';
import type { ConnectorTool } from './connector-sdk.js';
import { NATIVE_CONNECTORS } from './native.js';
import { detectProvider, getProviderProfile } from './providers.js';
import { checkInputSchema, cleanDescription } from './schema.js';
import type { NormalizedTool } from './types.js';

/**
 * Every tool every live connection offers, normalized. Native connectors and
 * MCP servers go through the same classifier and the same namespacing, so
 * `github.create_issue` means one thing whichever connection supplied it.
 *
 * Namespaces: a connection takes its provider's id ("github"). When a second
 * connection for the same provider offers a tool the first already has, it
 * is qualified by its account or name ("github-acme"), deterministically, so
 * policies and the audit log keep meaning the same tool across restarts.
 */

export interface CatalogEntry extends NormalizedTool {
  /** For a native tool: how to run it. */
  native?: ConnectorTool;
  /** For an MCP tool: the server's declared local capabilities, which feed capability policies. */
  serverCapabilities?: string[];
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'x';

/** The model-facing name: provider tool-name rules allow `^[a-zA-Z0-9_-]{1,64}$`. */
export function modelToolName(ref: string): string {
  const name = ref.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_');
  if (name.length <= 64) return name;
  // Too long: keep the end (the tool's own name matters most) and make it unique with a short hash.
  let hash = 0;
  for (const char of ref) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${name.slice(0, 20)}_${hash.toString(36)}_${name.slice(-(64 - 22 - hash.toString(36).length))}`.slice(0, 64);
}

interface Candidate {
  baseNamespace: string;
  qualifier: string;
  connectionId: string;
  createdAt: string;
  tools: Array<Omit<CatalogEntry, 'ref' | 'namespace' | 'modelName'>>;
}

function connectorCandidate(connector: ConnectorView): Candidate | undefined {
  const definition = NATIVE_CONNECTORS[connector.provider];
  if (!definition || connector.status !== 'connected') return undefined;
  const profile = getProviderProfile(connector.provider);
  return {
    baseNamespace: connector.provider,
    qualifier: slug(connector.accountName || connector.accountId || connector.id.slice(0, 8)),
    connectionId: connector.id,
    createdAt: connector.createdAt,
    tools: definition.tools.map((tool) => ({
      name: tool.name,
      description: cleanDescription(tool.description),
      inputSchema: tool.inputSchema,
      provider: connector.provider,
      category: definition.category,
      areas: profile?.areas ?? [],
      risk: tool.risk!,
      permission: tool.permission!,
      source: { kind: 'connector', connectionId: connector.id, connectionName: `${definition.name}${connector.accountName ? ` · ${connector.accountName}` : ''}`, trust: 'official', toolName: tool.name },
      native: tool,
    })),
  };
}

function mcpCandidate(server: McpServerRecord): Candidate | undefined {
  if (!server.enabled) return undefined;
  const provider = server.provider ?? detectProvider(server.url);
  const profile = getProviderProfile(provider);
  // Only a server someone vouched for is believed when it says a tool only reads.
  const trustAnnotations = server.trust === 'official' || server.trust === 'verified';
  return {
    baseNamespace: provider ?? slug(server.name),
    qualifier: slug(server.name),
    connectionId: server.id,
    createdAt: server.createdAt,
    tools: server.tools.filter((tool) => !server.disabledTools.includes(tool.name)).map((tool) => {
      const { risk, permission } = classifyTool({ name: tool.name, description: tool.description, provider, annotations: tool.annotations, trustAnnotations });
      const checked = checkInputSchema(tool.inputSchema);
      return {
        name: snakeCase(tool.name),
        description: cleanDescription(tool.description || tool.title || tool.name),
        inputSchema: checked.schema,
        provider,
        category: profile?.category ?? 'other',
        areas: profile?.areas ?? [],
        risk,
        permission,
        source: { kind: 'mcp_server', connectionId: server.id, connectionName: server.name, trust: server.trust, toolName: tool.name },
        serverCapabilities: server.capabilities,
        ...(checked.issues.length ? { schemaIssues: checked.issues } : {}),
      };
    }),
  };
}

/**
 * Assigns namespaces. Connections are taken oldest first; each takes the
 * plain provider namespace unless an earlier connection already offers one of
 * the same tool names there.
 */
function assemble(candidates: Candidate[]): CatalogEntry[] {
  const taken = new Map<string, Set<string>>();
  const entries: CatalogEntry[] = [];
  for (const candidate of [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.connectionId.localeCompare(b.connectionId))) {
    const names = candidate.tools.map((tool) => tool.name);
    let namespace = candidate.baseNamespace;
    const clashes = (ns: string) => names.some((name) => taken.get(ns)?.has(name));
    if (clashes(namespace)) {
      namespace = `${candidate.baseNamespace}-${candidate.qualifier}`;
      for (let n = 2; clashes(namespace); n += 1) namespace = `${candidate.baseNamespace}-${candidate.qualifier}-${n}`;
    }
    const used = taken.get(namespace) ?? new Set<string>();
    taken.set(namespace, used);
    for (const tool of candidate.tools) {
      if (used.has(tool.name)) continue; // a server listing one name twice gets it once
      used.add(tool.name);
      const ref = `${namespace}.${tool.name}`;
      entries.push({ ...tool, ref, namespace, modelName: modelToolName(ref) });
    }
  }
  return entries;
}

export function buildToolCatalog(db: Database): CatalogEntry[] {
  const candidates = [
    ...listConnectors(db).map(connectorCandidate),
    ...listMcpServers(db).map(mcpCandidate),
  ].filter((candidate): candidate is Candidate => Boolean(candidate));
  return assemble(candidates);
}

/** The tools an agent was given: connector grants and MCP tool assignments, with the skill that granted each. */
export function agentToolGrants(db: Database, agentId: string): Map<string, { skillId: string | null }> {
  const grants = new Map<string, { skillId: string | null }>();
  const connectorRows = db.prepare(`SELECT connector_id, capability, source_skill_id FROM connector_grants WHERE grantee_type = 'agent' AND grantee_id = ?`)
    .all(agentId) as Array<{ connector_id: string; capability: ConnectorCapability; source_skill_id: string | null }>;
  for (const row of connectorRows) grants.set(`${row.connector_id}\u0000${row.capability}`, { skillId: row.source_skill_id });
  const mcpRows = db.prepare(`SELECT t.server_id, t.tool_name, t.granted_capabilities, t.source_skill_id, s.capabilities
      FROM agent_mcp_tools t JOIN mcp_servers s ON s.id = t.server_id WHERE t.agent_id = ?`)
    .all(agentId) as Array<{ server_id: string; tool_name: string; granted_capabilities: string; source_skill_id: string | null; capabilities: string }>;
  for (const row of mcpRows) {
    // Declaring a new local capability withdraws the tool until someone acknowledges it again.
    const granted = JSON.parse(row.granted_capabilities) as string[];
    if (!(JSON.parse(row.capabilities) as string[]).every((capability) => granted.includes(capability))) continue;
    grants.set(`${row.server_id}\u0000${row.tool_name}`, { skillId: row.source_skill_id });
  }
  return grants;
}

export function toolsForAgent(db: Database, agentId: string, catalog = buildToolCatalog(db)): Array<CatalogEntry & { skillId: string | null }> {
  const grants = agentToolGrants(db, agentId);
  return catalog.flatMap((tool) => {
    const grant = grants.get(`${tool.source.connectionId}\u0000${tool.source.toolName}`);
    return grant ? [{ ...tool, skillId: grant.skillId }] : [];
  });
}

/** Strips what only the runtime needs, for the API. */
export function publicTool(tool: CatalogEntry): NormalizedTool {
  const { native: _native, serverCapabilities: _capabilities, ...rest } = tool;
  return rest;
}
