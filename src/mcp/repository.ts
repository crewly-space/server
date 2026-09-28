import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret, encryptDatabaseSecret } from '../db/secrets.js';
import type { McpPromptInfo, McpResourceInfo, McpServerInfo, McpToolInfo } from './client.js';
import type { TrustLevel } from '../tools/types.js';

export type McpCapability = 'shell' | 'filesystem' | 'network';
export const MCP_CAPABILITIES: readonly McpCapability[] = ['shell', 'filesystem', 'network'];

export type McpHealth = 'unknown' | 'connected' | 'degraded' | 'expired' | 'error';

/** OAuth client and tokens for a server that signs in with OAuth. Decrypted only in memory. */
export interface McpOAuthState {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource: string;
  scope?: string;
  clientId: string;
  clientSecret?: string;
  /** The redirect URI the client was registered with; a different one needs a new registration. */
  redirectUri?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface McpServerRecord {
  id: string;
  name: string;
  transport: 'http' | 'stdio';
  url: string | null;
  command: string | null;
  args: string[];
  headers: Record<string, string>;
  env: Record<string, string>;
  capabilities: McpCapability[];
  enabled: boolean;
  tools: McpToolInfo[];
  disabledTools: string[];
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  ownerUserId: string | null;
  provider: string | null;
  trust: TrustLevel;
  registryId: string | null;
  serverInfo: McpServerInfo;
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  oauth: McpOAuthState | null;
  health: McpHealth;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
}

interface McpServerRow {
  id: string;
  name: string;
  transport: 'http' | 'stdio';
  url: string | null;
  command: string | null;
  args: string;
  headers: string;
  env: string;
  capabilities: string;
  enabled: number;
  tools: string;
  disabled_tools: string;
  last_tested_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  owner_user_id: string | null;
  provider: string | null;
  trust: TrustLevel;
  registry_id: string | null;
  server_info: string;
  resources: string;
  prompts: string;
  oauth: string | null;
  health: McpHealth;
  last_success_at: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
}

function rowToRecord(db: Database, row: McpServerRow): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: JSON.parse(row.args),
    headers: JSON.parse(decryptDatabaseSecret(db, row.headers)),
    env: JSON.parse(decryptDatabaseSecret(db, row.env)),
    capabilities: JSON.parse(row.capabilities),
    enabled: row.enabled === 1,
    tools: JSON.parse(row.tools),
    disabledTools: JSON.parse(row.disabled_tools),
    lastTestedAt: row.last_tested_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerUserId: row.owner_user_id,
    provider: row.provider,
    trust: row.trust,
    registryId: row.registry_id,
    serverInfo: JSON.parse(row.server_info),
    resources: JSON.parse(row.resources),
    prompts: JSON.parse(row.prompts),
    oauth: row.oauth ? JSON.parse(decryptDatabaseSecret(db, row.oauth)) as McpOAuthState : null,
    health: row.health,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    consecutiveFailures: Number(row.consecutive_failures),
  };
}

export interface McpServerInput {
  name: string;
  transport: 'http' | 'stdio';
  url?: string | null;
  command?: string | null;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  capabilities?: McpCapability[];
  enabled?: boolean;
  ownerUserId?: string | null;
  provider?: string | null;
  trust?: TrustLevel;
  registryId?: string | null;
}

export function createMcpServer(db: Database, input: McpServerInput): McpServerRecord {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, url, command, args, headers, env, capabilities, enabled, created_at, updated_at,
       owner_user_id, provider, trust, registry_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.name, input.transport,
    input.transport === 'http' ? input.url ?? null : null,
    input.transport === 'stdio' ? input.command ?? null : null,
    JSON.stringify(input.args ?? []),
    encryptDatabaseSecret(db, JSON.stringify(input.headers ?? {})),
    encryptDatabaseSecret(db, JSON.stringify(input.env ?? {})),
    JSON.stringify(input.capabilities ?? []),
    input.enabled === false ? 0 : 1,
    now, now,
    input.ownerUserId ?? null, input.provider ?? null, input.trust ?? 'unverified', input.registryId ?? null,
  );
  return getMcpServer(db, id)!;
}

export function getMcpServer(db: Database, id: string): McpServerRecord | undefined {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
  return row ? rowToRecord(db, row) : undefined;
}

export function listMcpServers(db: Database): McpServerRecord[] {
  return (db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as McpServerRow[]).map((row) => rowToRecord(db, row));
}

export function updateMcpServer(db: Database, id: string, input: Partial<McpServerInput>): McpServerRecord | undefined {
  const existing = getMcpServer(db, id);
  if (!existing) return undefined;
  const merged = { ...existing, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as McpServerRecord;
  db.prepare(
    `UPDATE mcp_servers SET name = ?, transport = ?, url = ?, command = ?, args = ?, headers = ?, env = ?,
       capabilities = ?, enabled = ?, provider = ?, trust = ?, registry_id = ?, updated_at = ? WHERE id = ?`,
  ).run(
    merged.name, merged.transport,
    merged.transport === 'http' ? merged.url : null,
    merged.transport === 'stdio' ? merged.command : null,
    JSON.stringify(merged.args),
    encryptDatabaseSecret(db, JSON.stringify(merged.headers)),
    encryptDatabaseSecret(db, JSON.stringify(merged.env)),
    JSON.stringify(merged.capabilities),
    merged.enabled ? 1 : 0,
    merged.provider ?? null,
    merged.trust,
    merged.registryId ?? null,
    new Date().toISOString(),
    id,
  );
  return getMcpServer(db, id);
}

export function deleteMcpServer(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0;
}

export interface McpDiscovery {
  tools: McpToolInfo[];
  resources?: McpResourceInfo[];
  prompts?: McpPromptInfo[];
  serverInfo?: McpServerInfo;
}

/** What a test or discovery found. A failure also counts against the server's health. */
export function recordDiscovery(db: Database, id: string, outcome: McpDiscovery | { error: string; code?: string }): void {
  const now = new Date().toISOString();
  if ('tools' in outcome) {
    db.prepare(`UPDATE mcp_servers SET tools = ?, resources = ?, prompts = ?, server_info = ?, last_tested_at = ?, last_error = NULL,
        health = 'connected', last_success_at = ?, consecutive_failures = 0 WHERE id = ?`)
      .run(JSON.stringify(outcome.tools), JSON.stringify(outcome.resources ?? []), JSON.stringify(outcome.prompts ?? []),
        JSON.stringify(outcome.serverInfo ?? {}), now, now, id);
  } else {
    db.prepare('UPDATE mcp_servers SET last_tested_at = ?, last_error = ? WHERE id = ?').run(now, outcome.error, id);
    recordCallOutcome(db, id, { ok: false, error: outcome.error, code: outcome.code });
  }
}

/**
 * Health after a call: one failure after a success is `degraded`, several in
 * a row is `error`, a refused credential is `expired`. A success clears it.
 */
export function recordCallOutcome(db: Database, id: string, outcome: { ok: true } | { ok: false; error: string; code?: string }): void {
  const now = new Date().toISOString();
  if (outcome.ok) {
    db.prepare(`UPDATE mcp_servers SET health = 'connected', last_success_at = ?, consecutive_failures = 0, last_error = NULL WHERE id = ?`).run(now, id);
    return;
  }
  const row = db.prepare('SELECT consecutive_failures, last_success_at FROM mcp_servers WHERE id = ?').get(id) as { consecutive_failures: number; last_success_at: string | null } | undefined;
  if (!row) return;
  const failures = Number(row.consecutive_failures) + 1;
  const health: McpHealth = outcome.code === 'unauthorized' || outcome.code === 'oauth_expired' ? 'expired'
    : failures >= 3 || !row.last_success_at ? 'error' : 'degraded';
  db.prepare('UPDATE mcp_servers SET health = ?, consecutive_failures = ?, last_error = ?, last_error_at = ? WHERE id = ?')
    .run(health, failures, outcome.error.slice(0, 1000), now, id);
}

export function saveMcpOAuth(db: Database, id: string, oauth: McpOAuthState | null): void {
  db.prepare('UPDATE mcp_servers SET oauth = ?, updated_at = ? WHERE id = ?')
    .run(oauth ? encryptDatabaseSecret(db, JSON.stringify(oauth)) : null, new Date().toISOString(), id);
}

export function setDisabledTools(db: Database, id: string, disabled: string[]): void {
  db.prepare('UPDATE mcp_servers SET disabled_tools = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify([...new Set(disabled)].sort()), new Date().toISOString(), id);
}

export interface AgentToolAssignment {
  serverId: string;
  serverName: string;
  toolName: string;
  grantedCapabilities: McpCapability[];
}

export function listAgentTools(db: Database, agentId: string): AgentToolAssignment[] {
  return (db
    .prepare(
      `SELECT t.server_id, s.name AS server_name, t.tool_name, t.granted_capabilities
       FROM agent_mcp_tools t JOIN mcp_servers s ON s.id = t.server_id
       WHERE t.agent_id = ? ORDER BY s.name, t.tool_name`,
    )
    .all(agentId) as Array<{ server_id: string; server_name: string; tool_name: string; granted_capabilities: string }>)
    .map((row) => ({
      serverId: row.server_id,
      serverName: row.server_name,
      toolName: row.tool_name,
      grantedCapabilities: JSON.parse(row.granted_capabilities),
    }));
}

export function setAgentTools(
  db: Database,
  agentId: string,
  tools: Array<{ serverId: string; toolName: string; grantedCapabilities: McpCapability[] }>,
): void {
  db.transaction(() => {
    db.prepare('DELETE FROM agent_mcp_tools WHERE agent_id = ?').run(agentId);
    const insert = db.prepare(
      'INSERT OR IGNORE INTO agent_mcp_tools (agent_id, server_id, tool_name, granted_capabilities, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const now = new Date().toISOString();
    for (const tool of tools) insert.run(agentId, tool.serverId, tool.toolName, JSON.stringify(tool.grantedCapabilities), now);
  })();
}
