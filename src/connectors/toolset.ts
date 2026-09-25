import type { AgentToolset, ToolOutcome, ToolsetProvider } from '../providers/respond.js';
import type { Agent } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { connectorCall, hasConnectorGrant, listConnectors } from './service.js';
import { PROVIDERS } from './providers.js';

const inputSchema = { type: 'object', properties: { repo: { type: 'string' }, first: { type: 'number' }, teamId: { type: 'string' }, issueId: { type: 'string' }, issueNumber: { type: 'number' }, title: { type: 'string' }, body: { type: 'string' } }, additionalProperties: false };

export function connectorToolset(db: Database, fetchImpl: typeof fetch = fetch): ToolsetProvider {
  return (agent: Agent): AgentToolset | undefined => {
    const definitions = listConnectors(db).flatMap((connector) => PROVIDERS[connector.provider].capabilities.map((capability) => ({
      name: `connector_${connector.id.replace(/[^a-zA-Z0-9_]/g, '_')}_${capability}`.slice(0, 64),
      description: `${capability.replaceAll('_', ' ')} using the connected ${PROVIDERS[connector.provider].label}. Input is scoped to this connector and audited.`,
      inputSchema,
      capability,
      connectorId: connector.id,
    })));
    const granted = definitions.filter((definition) => hasConnectorGrant(db, { connectorId: definition.connectorId, granteeType: 'agent', granteeId: agent.id, capability: definition.capability }));
    if (!granted.length) return undefined;
    return {
      definitions: granted.map(({ name, description, inputSchema: schema }) => ({ name, description, inputSchema: schema })),
      async execute(call): Promise<ToolOutcome> {
        const definition = granted.find((entry) => entry.name === call.name);
        if (!definition) return { content: `There is no connector tool called ${call.name}.`, isError: true };
        try {
          const write = definition.capability === 'create_issue' || definition.capability === 'comment_on_issue' || definition.capability === 'comment_on_pull_request';
          const result = await connectorCall(db, { connectorId: definition.connectorId, agentId: agent.id, capability: definition.capability, operation: write ? 'write' : 'read', payload: call.input as Record<string, unknown> }, fetchImpl);
          return { content: JSON.stringify(result).slice(0, 50_000) };
        } catch (error) { return { content: `Connector action failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
      },
    };
  };
}
