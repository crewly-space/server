import type { AgentToolset, ToolOutcome, ToolsetProvider } from '../providers/respond.js';
import type { Agent } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { connectorCall, hasConnectorGrant, listConnectors } from './service.js';
import { PROVIDERS } from './providers.js';
import { authorizeCapabilityAction } from '../permissions/capabilities.js';

const inputSchema = { type: 'object', properties: {
  repo: { type: 'string', description: 'GitHub owner/repository.' }, project: { type: 'string', description: 'GitLab project path or numeric ID.' },
  first: { type: 'number' }, teamId: { type: 'string' }, issueId: { type: 'string' }, issueNumber: { type: 'number' },
  pageId: { type: 'string' }, parentPageId: { type: 'string' }, fileId: { type: 'string' }, query: { type: 'string' },
  filename: { type: 'string' }, mimeType: { type: 'string' }, path: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, content: { type: 'string' },
  workspaceId: { type: 'string' }, projectId: { type: 'string' }, taskId: { type: 'string' }, dueOn: { type: 'string' }, assignee: { type: 'string' },
  calendarId: { type: 'string' }, eventId: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, timeMin: { type: 'string' }, timeMax: { type: 'string' }, timeZone: { type: 'string' },
  messageId: { type: 'string' }, to: { type: 'string' }, cc: { type: 'string' }, bcc: { type: 'string' }, subject: { type: 'string' }, format: { type: 'string', enum: ['minimal', 'full', 'raw', 'metadata'] },
}, additionalProperties: false };

const WRITE_CAPABILITIES = new Set(['create_issue', 'comment_on_issue', 'comment_on_pull_request', 'create_page', 'comment_on_page', 'create_file', 'create_event', 'update_event', 'delete_event', 'send_email']);

export function connectorToolset(db: Database, fetchImpl: typeof fetch = fetch): ToolsetProvider {
  return (agent: Agent, input): AgentToolset | undefined => {
    // A disconnected connector keeps its grants for when it is reconnected, but offers no tools meanwhile.
    const definitions = listConnectors(db).filter((connector) => connector.status === 'connected').flatMap((connector) => PROVIDERS[connector.provider].capabilities.map((capability) => ({
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
          const write = WRITE_CAPABILITIES.has(definition.capability);
          if (input.run) {
            for (const capability of write ? ['network.access', 'external.side_effect'] as const : ['network.access'] as const) {
              const authorization = authorizeCapabilityAction(db, { agentId: agent.id, runId: input.run.runId, capability,
                action: `connector.${definition.connectorId}.${definition.capability}`, scope: { connector: definition.connectorId }, target: call.input });
              if (!authorization.allowed) return { content: authorization.reason === 'denied'
                ? `${capability} is denied by this agent's policy.`
                : `Approval required for ${definition.capability}. The exact action has been queued for an owner.`, isError: true };
            }
          }
          const result = await connectorCall(db, { connectorId: definition.connectorId, agentId: agent.id, capability: definition.capability, operation: write ? 'write' : 'read', payload: call.input as Record<string, unknown> }, fetchImpl);
          return { content: JSON.stringify(result).slice(0, 50_000) };
        } catch (error) { return { content: `Connector action failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
      },
    };
  };
}
