import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';
import type { ConnectionHealth, TrustLevel } from './tools.js';

export type McpCapability = 'shell' | 'filesystem' | 'network';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

/**
 * An MCP server as the API shows it. Header and env values that could be a
 * pasted credential come back as `••••••`; send that back unchanged to keep one.
 */
export interface McpServer {
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
  tools: McpTool[];
  disabledTools: string[];
  availableTools: string[];
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  // The fields below come from servers with the tool platform; older servers omit them.
  provider?: string | null;
  trust?: TrustLevel;
  registryId?: string | null;
  serverInfo?: { name?: string; title?: string; version?: string; protocolVersion?: string; capabilities?: Record<string, unknown>; instructions?: string };
  resources?: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  prompts?: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
  /** Whether it is signed in with OAuth; never the token. */
  oauth?: { signedIn: boolean; issuer: string | null; scope: string | null; expiresAt: string | null } | null;
  status?: ConnectionHealth;
  health?: 'unknown' | 'connected' | 'degraded' | 'expired' | 'error';
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  consecutiveFailures?: number;
}

export interface McpServerInput {
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  /** Values may use `{{secret:NAME}}` for secrets granted to this server. */
  headers?: Record<string, string>;
  env?: Record<string, string>;
  capabilities?: McpCapability[];
  enabled?: boolean;
  /** The provider it speaks for ('github'), when Crewly cannot tell from its URL. */
  provider?: string | null;
  trust?: TrustLevel;
}

export interface AgentToolAssignment {
  serverId: string;
  serverName: string;
  toolName: string;
  grantedCapabilities: McpCapability[];
}

export type McpTestResult =
  | { ok: true; tools: McpTool[]; server: McpServer }
  | { ok: false; error: { code: string; message: string }; server: McpServer };

export class McpResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<{ servers: McpServer[] }> {
    return this.http.request('GET', '/api/v1/mcp-servers');
  }

  create(input: McpServerInput): Promise<McpServer> {
    return this.http.request('POST', '/api/v1/mcp-servers', input);
  }

  update(id: string, input: Partial<McpServerInput>): Promise<McpServer> {
    return this.http.request('PATCH', `/api/v1/mcp-servers/${encodePathSegment(id)}`, input);
  }

  delete(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/mcp-servers/${encodePathSegment(id)}`);
  }

  /** Connects and discovers tools; a failure comes back as `{ok: false, error}` rather than throwing. */
  test(id: string): Promise<McpTestResult> {
    return this.http.request('POST', `/api/v1/mcp-servers/${encodePathSegment(id)}/test`);
  }

  setDisabledTools(id: string, disabled: string[]): Promise<McpServer> {
    return this.http.request('PUT', `/api/v1/mcp-servers/${encodePathSegment(id)}/tools`, { disabled });
  }

  agentTools(agentId: string): Promise<{ tools: AgentToolAssignment[] }> {
    return this.http.request('GET', `/api/v1/agents/${encodePathSegment(agentId)}/tools`);
  }

  /** Tools from a server with capabilities need an admin and an explicit acknowledgement. */
  setAgentTools(
    agentId: string,
    tools: Array<{ serverId: string; toolName: string }>,
    acknowledgeCapabilities: McpCapability[] = [],
  ): Promise<{ tools: AgentToolAssignment[] }> {
    return this.http.request('PUT', `/api/v1/agents/${encodePathSegment(agentId)}/tools`, { tools, acknowledgeCapabilities });
  }

  /** Starts signing the server in with OAuth; send the browser to `authorizationUrl`. */
  startOAuth(id: string, callbackUrl: string): Promise<{ authorizationUrl: string; state: string }> {
    return this.http.request('POST', `/api/v1/mcp-servers/${encodePathSegment(id)}/oauth/start`, { callbackUrl });
  }

  /** Finishes signing in with what the authorization server sent back, then discovers the server's tools. */
  completeOAuth(state: string, code: string): Promise<McpTestResult> {
    return this.http.request('POST', '/api/v1/mcp-servers/oauth/complete', { state, code });
  }

  signOut(id: string): Promise<McpServer> {
    return this.http.request('DELETE', `/api/v1/mcp-servers/${encodePathSegment(id)}/oauth`);
  }
}
