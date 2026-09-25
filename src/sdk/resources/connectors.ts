import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export type ConnectorProvider = 'github';
export type ConnectorStatus = 'pending' | 'connected' | 'action_required' | 'permission_revoked' | 'rate_limited' | 'provider_unavailable' | 'revoked';
export type ConnectorCapability = 'read_profile' | 'read_repository' | 'read_issues' | 'create_issue' | 'comment_on_pull_request';
export interface Connector {
  id: string; provider: ConnectorProvider; accountId: string | null; accountName: string | null; accountUrl: string | null;
  scopes: string[]; status: ConnectorStatus; ownerUserId: string; createdAt: string; updatedAt: string;
  lastUsedAt: string | null; lastCheckedAt: string | null; revokedAt: string | null; lastError: string | null; capabilities: ConnectorCapability[];
}
export interface ConnectorGrant { connectorId: string; granteeType: 'agent' | 'automation' | 'integration'; granteeId: string; capability: ConnectorCapability; createdAt: string; }
export interface ConnectorOAuthStart { connectorId: string; state: string; authorizeUrl: string; }

export class ConnectorsResource {
  constructor(private readonly http: HttpClient) {}
  providers(): Promise<{ providers: Array<{ provider: ConnectorProvider; label: string; description: string; capabilities: ConnectorCapability[]; scopes: string[] }> }> { return this.http.request('GET', '/api/v1/connectors/providers'); }
  list(): Promise<{ connectors: Connector[] }> { return this.http.request('GET', '/api/v1/connectors'); }
  startGitHubOAuth(input: { callbackUrl: string; scopes?: string[] }): Promise<ConnectorOAuthStart> { return this.http.request('POST', '/api/v1/connectors/oauth/github/start', input); }
  completeGitHubOAuth(input: { state: string; code: string }): Promise<Connector> { return this.http.request('POST', '/api/v1/connectors/oauth/github/complete', input); }
  refresh(id: string): Promise<Connector> { return this.http.request('POST', `/api/v1/connectors/${encodePathSegment(id)}/refresh`); }
  revoke(id: string): Promise<Connector> { return this.http.request('POST', `/api/v1/connectors/${encodePathSegment(id)}/revoke`); }
  grants(id: string): Promise<{ grants: ConnectorGrant[] }> { return this.http.request('GET', `/api/v1/connectors/${encodePathSegment(id)}/grants`); }
  setGrants(id: string, grants: Array<Omit<ConnectorGrant, 'connectorId' | 'createdAt'>>): Promise<{ grants: ConnectorGrant[] }> { return this.http.request('PUT', `/api/v1/connectors/${encodePathSegment(id)}/grants`, { grants }); }
  audit(id: string): Promise<{ entries: Array<Record<string, unknown>> }> { return this.http.request('GET', `/api/v1/connectors/${encodePathSegment(id)}/audit`); }
}
