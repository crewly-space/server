import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export type McpCapability = 'shell' | 'filesystem' | 'network';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
}
