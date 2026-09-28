import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

/** How much harm a tool call can do, least to most. */
export type ToolRisk = 'read' | 'write' | 'external_message' | 'delete' | 'execute' | 'deploy' | 'financial' | 'admin' | 'dangerous';
/** What happens when an agent calls a tool it was given. */
export type ToolPolicyMode = 'always' | 'ask_once' | 'ask_every_time' | 'blocked';
export type TrustLevel = 'official' | 'verified' | 'community' | 'unverified';
export type ToolSelectorType = 'tool' | 'permission' | 'risk' | 'connection';
export type ConnectionHealth = 'connected' | 'degraded' | 'expired' | 'error' | 'disabled' | 'pending';

/**
 * A tool as every part of Crewly sees it, whether a native connector or an
 * MCP server supplies it. `ref` (`github.create_pull_request`) is stable and
 * is what policies and the audit log use.
 */
export interface NormalizedTool {
  ref: string;
  namespace: string;
  name: string;
  modelName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  provider: string | null;
  category: string;
  areas: string[];
  risk: ToolRisk;
  permission: string;
  source: { kind: 'connector' | 'mcp_server'; connectionId: string; connectionName: string; trust: TrustLevel; toolName: string };
  schemaIssues?: string[];
}

export interface ProviderProfile {
  id: string;
  name: string;
  category: string;
  areas: string[];
  integrations: Array<{ kind: 'native' | 'mcp' | 'api'; label: string; url?: string; auth: string; official: boolean }>;
  defaultModes?: Record<string, ToolPolicyMode>;
  large?: boolean;
  priority?: 'P0' | 'P1' | 'P2';
  /** Live connections to it in this workspace. */
  connections: number;
}

export interface AgentToolAccess {
  tool: NormalizedTool;
  /** The skill whose authorization granted it, if any. */
  skillId: string | null;
  mode: ToolPolicyMode;
  /** Why, in words a person can act on. */
  reason: string;
  /** Whether the model is offered it at all. */
  exposed: boolean;
}

export interface ToolPolicy {
  id: string;
  agentId: string | null;
  selectorType: ToolSelectorType;
  selector: string;
  mode: ToolPolicyMode;
  sourceSkillId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolExecution {
  id: string;
  createdAt: string;
  agentId: string | null;
  userId: string | null;
  runId: string | null;
  conversationId: string | null;
  skillId: string | null;
  connectionKind: 'connector' | 'mcp_server';
  connectionId: string;
  provider: string | null;
  toolRef: string;
  toolName: string;
  risk: ToolRisk;
  permission: string | null;
  /** With secrets redacted. */
  arguments: unknown;
  status: 'success' | 'error' | 'blocked' | 'approval_required';
  policyMode: ToolPolicyMode | null;
  approvalId: string | null;
  resultMeta: Record<string, unknown>;
  durationMs: number;
  error: string | null;
}

export interface Connection {
  kind: 'connector' | 'mcp_server';
  id: string;
  name: string;
  provider: string | null;
  status: ConnectionHealth;
  trust: TrustLevel;
  account: string | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  toolsAvailable: number;
}

export class ToolsResource {
  constructor(private readonly http: HttpClient) {}

  /** Every tool every live connection offers; `query` searches it. Needs integrations.manage. */
  catalog(query?: string): Promise<{ tools: NormalizedTool[] }> {
    return this.http.request('GET', `/api/v1/tools${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  }

  providers(): Promise<{ providers: ProviderProfile[] }> {
    return this.http.request('GET', '/api/v1/tools/providers');
  }

  connections(): Promise<{ connections: Connection[] }> {
    return this.http.request('GET', '/api/v1/connections');
  }

  /** Every tool an agent has and what happens when it calls each. */
  agentAccess(agentId: string): Promise<{ tools: AgentToolAccess[] }> {
    return this.http.request('GET', `/api/v1/agents/${encodePathSegment(agentId)}/tool-access`);
  }

  /** Forgets "ask once" approvals, so the agent asks again. */
  forgetApprovals(agentId: string, toolRef?: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/agents/${encodePathSegment(agentId)}/tool-approvals${toolRef ? `?tool=${encodeURIComponent(toolRef)}` : ''}`);
  }

  /** An agent's rules and the workspace's; with no agent, the workspace's. */
  policies(agentId?: string): Promise<{ policies: ToolPolicy[]; workspace: ToolPolicy[] }> {
    return this.http.request('GET', `/api/v1/tool-policies${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`);
  }

  /** Replaces one agent's rules, or the workspace's (null). Only admins can make a tool run without asking. */
  setPolicies(agentId: string | null, policies: Array<{ selectorType: ToolSelectorType; selector: string; mode: ToolPolicyMode }>): Promise<{ policies: ToolPolicy[] }> {
    return this.http.request('PUT', '/api/v1/tool-policies', { agentId, policies });
  }

  /** The audit log of tool executions, newest first. */
  executions(filter: { agentId?: string; connectionId?: string; runId?: string; status?: ToolExecution['status']; tool?: string; before?: string; limit?: number } = {}): Promise<{ executions: ToolExecution[] }> {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    const text = query.toString();
    return this.http.request('GET', `/api/v1/tool-executions${text ? `?${text}` : ''}`);
  }
}
