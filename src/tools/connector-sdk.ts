import type { Database } from '../db/driver.js';
import type { ToolAnnotations } from './classify.js';
import { AUTH_TYPES, PROVIDER_CATEGORIES, TOOL_RISKS, type AuthType, type ProviderCategory, type ToolRisk } from './types.js';

/**
 * The connector SDK: how a native Crewly connector is declared. A connector
 * is data plus an `execute` per tool; it never sees the model, and the model
 * never sees its credential. The tool runtime resolves the credential,
 * applies policy and approvals, executes, and audits -- exactly as it does
 * for a tool that came from an MCP server.
 *
 *   export default defineConnector({
 *     id: 'stripe', name: 'Stripe', category: 'finance',
 *     auth: { type: 'oauth2' },
 *     tools: [listCustomers, createRefund],
 *     permissions: ['customers:read', 'refunds:write'],
 *   });
 */

export interface ToolContext {
  db: Database;
  connectionId: string;
  agentId: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

export interface ConnectorTool<Input extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `resource:action` from the shared vocabulary. Derived from the name when omitted. */
  permission?: string;
  /** Derived from the name when omitted; state it for anything the name undersells. */
  risk?: ToolRisk;
  annotations?: ToolAnnotations;
  execute(context: ToolContext, input: Input): Promise<unknown>;
}

export interface ConnectorDefinition {
  id: string;
  name: string;
  category: ProviderCategory;
  auth: { type: AuthType; scopes?: string[] };
  tools: ConnectorTool[];
  /** Every permission any tool uses, declared up front so it can be reviewed before installing. */
  permissions: string[];
}

export class ConnectorDefinitionError extends Error {}

const ID = /^[a-z][a-z0-9-]{0,40}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,60}$/;
const PERMISSION = /^[a-z][a-z0-9_.]*:[a-z][a-z0-9_]*$/;

export function defineTool<Input extends Record<string, unknown>>(tool: ConnectorTool<Input>): ConnectorTool {
  return tool as unknown as ConnectorTool;
}

export function defineConnector(definition: ConnectorDefinition): Readonly<ConnectorDefinition> {
  if (!ID.test(definition.id)) throw new ConnectorDefinitionError(`connector id "${definition.id}" must be lowercase letters, digits and dashes`);
  if (!PROVIDER_CATEGORIES.includes(definition.category)) throw new ConnectorDefinitionError(`unknown category ${definition.category}`);
  if (!AUTH_TYPES.includes(definition.auth.type)) throw new ConnectorDefinitionError(`unknown auth type ${definition.auth.type}`);
  const names = new Set<string>();
  for (const tool of definition.tools) {
    if (!TOOL_NAME.test(tool.name)) throw new ConnectorDefinitionError(`${definition.id}: tool name "${tool.name}" must be snake_case`);
    if (names.has(tool.name)) throw new ConnectorDefinitionError(`${definition.id}: tool "${tool.name}" is declared twice`);
    names.add(tool.name);
    if (tool.risk && !TOOL_RISKS.includes(tool.risk)) throw new ConnectorDefinitionError(`${definition.id}.${tool.name}: unknown risk ${tool.risk}`);
    if (tool.permission && !PERMISSION.test(tool.permission)) throw new ConnectorDefinitionError(`${definition.id}.${tool.name}: permission must look like resource:action`);
    if (tool.permission && !definition.permissions.includes(tool.permission)) {
      throw new ConnectorDefinitionError(`${definition.id}.${tool.name} uses ${tool.permission}, which the connector does not declare`);
    }
    if (tool.inputSchema.type !== 'object') throw new ConnectorDefinitionError(`${definition.id}.${tool.name}: inputSchema must be an object schema`);
  }
  return Object.freeze({ ...definition, tools: [...definition.tools], permissions: [...definition.permissions] });
}
