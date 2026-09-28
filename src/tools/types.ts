/**
 * The one shape every tool takes, whatever supplied it. A native connector
 * and an MCP server both end up as NormalizedTool, so an agent, a policy, a
 * skill or the audit log never has to know where `github.create_pull_request`
 * came from.
 */

/** How much harm a call can do, least to most. Order matters: it is used to pick the stricter of two. */
export const TOOL_RISKS = [
  'read', 'write', 'external_message', 'delete', 'execute', 'deploy', 'financial', 'admin', 'dangerous',
] as const;
export type ToolRisk = typeof TOOL_RISKS[number];

export function riskRank(risk: ToolRisk): number {
  return TOOL_RISKS.indexOf(risk);
}

export function stricterRisk(a: ToolRisk, b: ToolRisk): ToolRisk {
  return riskRank(a) >= riskRank(b) ? a : b;
}

/** What happens when an agent calls a tool it has been given. */
export const TOOL_POLICY_MODES = ['always', 'ask_once', 'ask_every_time', 'blocked'] as const;
export type ToolPolicyMode = typeof TOOL_POLICY_MODES[number];

const MODE_ORDER: readonly ToolPolicyMode[] = ['always', 'ask_once', 'ask_every_time', 'blocked'];
export function stricterMode(a: ToolPolicyMode, b: ToolPolicyMode): ToolPolicyMode {
  return MODE_ORDER.indexOf(a) >= MODE_ORDER.indexOf(b) ? a : b;
}

/** How far a connection's publisher is trusted. Nothing is trusted merely for being listed somewhere. */
export const TRUST_LEVELS = ['official', 'verified', 'community', 'unverified'] as const;
export type TrustLevel = typeof TRUST_LEVELS[number];

/** Every way a connection can authenticate. Credentials are resolved by the runtime, never by the model. */
export const AUTH_TYPES = [
  'oauth2', 'api_key', 'bearer_token', 'basic', 'service_account', 'github_app',
  'custom_headers', 'cli', 'mcp_oauth', 'mcp_token', 'none',
] as const;
export type AuthType = typeof AUTH_TYPES[number];

export const PROVIDER_CATEGORIES = [
  'development', 'cloud', 'databases', 'monitoring', 'finance', 'analytics', 'crm', 'support',
  'communication', 'knowledge', 'project_management', 'design', 'marketing', 'identity',
  'automation', 'ai', 'browser', 'security', 'other',
] as const;
export type ProviderCategory = typeof PROVIDER_CATEGORIES[number];

export type ConnectionKind = 'connector' | 'mcp_server';

export interface ToolSource {
  kind: ConnectionKind;
  connectionId: string;
  connectionName: string;
  trust: TrustLevel;
  /** The name the connection itself uses for the tool. */
  toolName: string;
}

export interface NormalizedTool {
  /** Stable, namespaced reference: `github.create_pull_request`. Policies and audit use this. */
  ref: string;
  /** `github`, or `github-acme` when two connections speak for the same provider. */
  namespace: string;
  /** The tool's own name, normalized to snake_case. */
  name: string;
  /** What the model sees: `^[a-zA-Z0-9_-]{1,64}$`, unique within one agent's turn. */
  modelName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  provider: string | null;
  category: ProviderCategory;
  /** Capability areas the provider covers ('code_host', 'error_tracking'), which skills depend on. */
  areas: string[];
  risk: ToolRisk;
  /** `resource:action`, from the shared vocabulary skills declare: `pull_request:create`. */
  permission: string;
  source: ToolSource;
  /** Present when the schema could not be offered as-is; such a tool is never exposed. */
  schemaIssues?: string[];
}
