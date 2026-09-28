import { connectorCall } from '../connectors/service.js';
import { CONNECTOR_PROVIDERS, PROVIDERS, type ConnectorCapability, type ConnectorProvider } from '../connectors/providers.js';
import { classifyTool } from './classify.js';
import { defineConnector, type ConnectorDefinition, type ConnectorTool } from './connector-sdk.js';
import { getProviderProfile } from './providers.js';

/**
 * The native OAuth connectors, declared through the connector SDK. Their
 * HTTP calls stay where they are (connectors/service.ts, already tested);
 * this is what turns them into tools with a schema, a permission and a risk
 * that the tool runtime treats exactly like an MCP server's.
 */

const s = (description: string) => ({ type: 'string', description });
const n = (description: string) => ({ type: 'number', description });

const repo = { repo: s('owner/repository (GitHub)'), project: s('Project path or numeric ID (GitLab)') };
const PROPERTIES: Record<ConnectorCapability, Record<string, unknown>> = {
  read_profile: {},
  read_repository: repo,
  read_issues: { ...repo, first: n('How many to return'), teamId: s('Team ID (Linear)'), projectId: s('Project ID'), workspaceId: s('Workspace ID (Asana)') },
  create_issue: { ...repo, teamId: s('Team ID (Linear)'), projectId: s('Project ID'), workspaceId: s('Workspace ID'), title: s('Title'), body: s('Description, markdown'), assignee: s('Assignee'), dueOn: s('Due date, YYYY-MM-DD') },
  comment_on_issue: { ...repo, issueId: s('Issue ID'), issueNumber: n('Issue number'), taskId: s('Task ID (Asana)'), body: s('Comment, markdown') },
  comment_on_pull_request: { ...repo, issueNumber: n('Pull or merge request number'), body: s('Comment, markdown') },
  read_projects: { first: n('How many to return'), workspaceId: s('Workspace ID'), teamId: s('Team ID') },
  read_channels: { limit: n('How many channels'), cursor: s('Pagination cursor') },
  read_messages: { channel: s('Channel ID'), limit: n('How many messages'), cursor: s('Pagination cursor') },
  post_messages: { channel: s('Channel ID'), text: s('Message text'), thread_ts: s('Reply in this thread') },
  read_pages: { pageId: s('Page ID') },
  search_pages: { query: s('Search text') },
  create_page: { parentPageId: s('Parent page ID'), title: s('Title'), content: s('Content, markdown') },
  comment_on_page: { pageId: s('Page ID'), body: s('Comment') },
  read_files: { fileId: s('File ID'), path: s('Path (Dropbox)') },
  search_files: { query: s('Search text') },
  create_file: { filename: s('File name'), mimeType: s('MIME type'), content: s('Content'), path: s('Path (Dropbox)') },
  read_calendar: {},
  read_events: { calendarId: s('Calendar ID, default primary'), timeMin: s('ISO start'), timeMax: s('ISO end'), query: s('Search text') },
  create_event: { calendarId: s('Calendar ID'), title: s('Title'), body: s('Description'), start: s('ISO start'), end: s('ISO end'), timeZone: s('IANA time zone') },
  update_event: { calendarId: s('Calendar ID'), eventId: s('Event ID'), title: s('Title'), body: s('Description'), start: s('ISO start'), end: s('ISO end'), timeZone: s('IANA time zone') },
  delete_event: { calendarId: s('Calendar ID'), eventId: s('Event ID') },
  read_email: { messageId: s('Message ID'), format: { type: 'string', enum: ['minimal', 'full', 'raw', 'metadata'] } },
  search_email: { query: s('Gmail search query'), first: n('How many') },
  send_email: { to: s('Recipients'), cc: s('Cc'), bcc: s('Bcc'), subject: s('Subject'), body: s('Body') },
};
const REQUIRED: Partial<Record<ConnectorCapability, string[]>> = {
  post_messages: ['channel', 'text'], read_messages: ['channel'], send_email: ['to', 'subject', 'body'], delete_event: ['eventId'],
  update_event: ['eventId'], read_pages: ['pageId'], comment_on_page: ['pageId', 'body'], search_pages: ['query'], search_files: ['query'],
};

/** Native capabilities that change something on the provider, as connectorCall means "write". */
export const NATIVE_WRITE_CAPABILITIES = new Set<ConnectorCapability>(['create_issue', 'comment_on_issue', 'comment_on_pull_request', 'post_messages',
  'create_page', 'comment_on_page', 'create_file', 'create_event', 'update_event', 'delete_event', 'send_email']);

function nativeTool(provider: ConnectorProvider, capability: ConnectorCapability): ConnectorTool {
  const { risk, permission } = classifyTool({ name: capability, provider });
  return {
    name: capability,
    description: `${capability.replaceAll('_', ' ')} on ${PROVIDERS[provider].label}.`,
    inputSchema: { type: 'object', properties: PROPERTIES[capability], ...(REQUIRED[capability] ? { required: REQUIRED[capability] } : {}), additionalProperties: false },
    risk,
    permission,
    execute: (context, input) => connectorCall(context.db, {
      connectorId: context.connectionId, agentId: context.agentId, capability,
      operation: NATIVE_WRITE_CAPABILITIES.has(capability) ? 'write' : 'read', payload: input,
    }, context.fetch),
  };
}

export const NATIVE_CONNECTORS: Readonly<Record<ConnectorProvider, Readonly<ConnectorDefinition>>> = Object.fromEntries(
  CONNECTOR_PROVIDERS.map((provider) => {
    const tools = PROVIDERS[provider].capabilities.map((capability) => nativeTool(provider, capability));
    return [provider, defineConnector({
      id: provider,
      name: PROVIDERS[provider].label,
      category: getProviderProfile(provider)?.category ?? 'other',
      auth: { type: 'oauth2', scopes: PROVIDERS[provider].scopes },
      tools,
      permissions: [...new Set(tools.map((tool) => tool.permission!))],
    })];
  }),
) as Record<ConnectorProvider, ConnectorDefinition>;
