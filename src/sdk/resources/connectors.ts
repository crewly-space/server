import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export type ConnectorProvider = 'github' | 'gitlab' | 'linear' | 'asana' | 'notion' | 'google-drive' | 'google-calendar' | 'gmail' | 'dropbox' | 'slack';
export type ConnectorStatus = 'pending' | 'connected' | 'action_required' | 'permission_revoked' | 'rate_limited' | 'provider_unavailable' | 'revoked';
export type ConnectorCapability = 'read_profile' | 'read_repository' | 'read_issues' | 'create_issue' | 'comment_on_pull_request' | 'read_projects' | 'comment_on_issue' | 'read_channels' | 'read_messages' | 'post_messages' | 'read_pages' | 'search_pages' | 'create_page' | 'comment_on_page' | 'read_files' | 'search_files' | 'create_file' | 'read_calendar' | 'read_events' | 'create_event' | 'update_event' | 'delete_event' | 'read_email' | 'search_email' | 'send_email';
/** A connectable app, and whether this server has the OAuth app it needs. */
export interface ConnectorProviderDefinition {
  provider: ConnectorProvider; label: string; description: string; capabilities: ConnectorCapability[]; scopes: string[];
  /** False until the server has OAuth credentials; older servers omit it. */
  configured?: boolean;
  /** What an admin sets to make `configured` true. */
  setup?: { clientIdEnv: string; clientSecretEnv: string; setupUrl: string };
}
/** Pass `connectorId` to reconnect that connector rather than add another. */
export interface ConnectorOAuthStartInput { callbackUrl: string; scopes?: string[]; connectorId?: string; }
export interface SlackImportChannel { id: string; name: string; topic: string; isPrivate: boolean; }
export interface SlackImportSummary { importId: string; status: string; createdChannels: number; matchedChannels: number; importedMessages: number; invitedMembers: number; skipped: number; failed: string[]; }
export interface Connector {
  id: string; provider: ConnectorProvider; accountId: string | null; accountName: string | null; accountUrl: string | null;
  scopes: string[]; status: ConnectorStatus; ownerUserId: string; createdAt: string; updatedAt: string;
  lastUsedAt: string | null; lastCheckedAt: string | null; revokedAt: string | null; lastError: string | null; capabilities: ConnectorCapability[];
}
export interface ConnectorGrant { connectorId: string; granteeType: 'agent' | 'automation' | 'integration'; granteeId: string; capability: ConnectorCapability; createdAt: string; }
export interface ConnectorOAuthStart { connectorId: string; state: string; authorizeUrl: string; }

export class ConnectorsResource {
  constructor(private readonly http: HttpClient) {}
  providers(): Promise<{ providers: ConnectorProviderDefinition[] }> { return this.http.request('GET', '/api/v1/connectors/providers'); }
  list(): Promise<{ connectors: Connector[] }> { return this.http.request('GET', '/api/v1/connectors'); }
  startOAuth(provider: ConnectorProvider, input: ConnectorOAuthStartInput): Promise<ConnectorOAuthStart> { return this.http.request('POST', `/api/v1/connectors/oauth/${encodePathSegment(provider)}/start`, input); }
  completeOAuth(provider: ConnectorProvider, input: { state: string; code: string }): Promise<Connector> { return this.http.request('POST', `/api/v1/connectors/oauth/${encodePathSegment(provider)}/complete`, input); }
  startGitHubOAuth(input: { callbackUrl: string; scopes?: string[] }): Promise<ConnectorOAuthStart> { return this.startOAuth('github', input); }
  completeGitHubOAuth(input: { state: string; code: string }): Promise<Connector> { return this.completeOAuth('github', input); }
  startLinearOAuth(input: { callbackUrl: string; scopes?: string[] }): Promise<ConnectorOAuthStart> { return this.startOAuth('linear', input); }
  completeLinearOAuth(input: { state: string; code: string }): Promise<Connector> { return this.completeOAuth('linear', input); }
  startSlackOAuth(input: { callbackUrl: string; scopes?: string[] }): Promise<ConnectorOAuthStart> { return this.startOAuth('slack', input); }
  completeSlackOAuth(input: { state: string; code: string }): Promise<Connector> { return this.completeOAuth('slack', input); }
  slackChannels(id: string): Promise<{ channels: SlackImportChannel[] }> { return this.http.request('GET', `/api/v1/connectors/${encodePathSegment(id)}/slack/channels`); }
  importSlack(id: string, input: { channelIds: string[]; historyLimit?: number; importMembers?: boolean }): Promise<SlackImportSummary> { return this.http.request('POST', `/api/v1/connectors/${encodePathSegment(id)}/slack/import`, input); }
  refresh(id: string): Promise<Connector> { return this.http.request('POST', `/api/v1/connectors/${encodePathSegment(id)}/refresh`); }
  revoke(id: string): Promise<Connector> { return this.http.request('POST', `/api/v1/connectors/${encodePathSegment(id)}/revoke`); }
  grants(id: string): Promise<{ grants: ConnectorGrant[] }> { return this.http.request('GET', `/api/v1/connectors/${encodePathSegment(id)}/grants`); }
  setGrants(id: string, grants: Array<Omit<ConnectorGrant, 'connectorId' | 'createdAt'>>): Promise<{ grants: ConnectorGrant[] }> { return this.http.request('PUT', `/api/v1/connectors/${encodePathSegment(id)}/grants`, { grants }); }
  audit(id: string): Promise<{ entries: Array<Record<string, unknown>> }> { return this.http.request('GET', `/api/v1/connectors/${encodePathSegment(id)}/audit`); }
}
