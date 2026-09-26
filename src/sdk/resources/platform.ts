import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export type ExecutionCapability = 'filesystem.read' | 'filesystem.write' | 'process.execute' | 'network.access' | 'secret.read' | 'external.side_effect' | 'browser.control';
export type CapabilityDecision = 'allow' | 'ask' | 'deny';
export interface CapabilityPolicy {
  id: string;
  agentId: string | null;
  capability: ExecutionCapability;
  decision: CapabilityDecision;
  scope: Record<string, string | string[]>;
  createdAt: string;
  updatedAt: string;
}
export interface CapabilityPolicyInput { capability: ExecutionCapability; decision: CapabilityDecision; scope?: Record<string, string | string[]>; }

export interface RegistryVersion { version: string; }
export interface RegistryItem {
  id: string;
  type: 'skill' | 'mcp_preset';
  name: string;
  description: string;
  publisher: string;
  verified: boolean;
  compatibility: string;
  requiredCapabilities: string[];
  requiredSecrets: string[];
  versions: RegistryVersion[];
}
export interface RegistryInstallation {
  id: string;
  itemType: RegistryItem['type'];
  registryId: string;
  name: string;
  publisher: string;
  version: string;
  pinnedVersion: string | null;
  verified: boolean | number;
  installedResourceId: string;
  installedAt: string;
  updatedAt: string;
}
export interface RegistrySettings { enabled: boolean; registryUrl: string | null; allowUnverified: boolean; }

export interface FederationSettings { serverId: string; enabled: boolean; displayName: string; }
export interface FederationConnection {
  id: string;
  remoteUrl: string;
  remoteServerId: string | null;
  remoteConnectionId: string | null;
  remoteName: string | null;
  status: 'pending' | 'active' | 'revoked' | 'unreachable' | 'incompatible';
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
}
export interface FederationEvent { id: string; type: string; scope: string; direction: 'inbound' | 'outbound'; status: string; hopCount: number; createdAt: string; }

export interface BrowserSession {
  id: string;
  runId: string;
  agentId: string;
  status: string;
  persistent: number | boolean;
  pageCount: number;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  lastError: string | null;
}
export interface BrowserAction { id: string; action: string; url: string | null; status: string; artifactId: string | null; durationMs: number; createdAt: string; }

/** Administration APIs that span agents, the registry, federation and browser runs. */
export class PlatformResource {
  constructor(private readonly http: HttpClient) {}

  capabilityPolicies(agentId?: string): Promise<{ capabilities: ExecutionCapability[]; policies: CapabilityPolicy[] }> {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    return this.http.request('GET', `/api/v1/capability-policies${query}`);
  }
  setDefaultCapabilityPolicies(policies: CapabilityPolicyInput[]): Promise<{ policies: CapabilityPolicy[] }> {
    return this.http.request('PUT', '/api/v1/capability-policies/defaults', { policies });
  }
  setAgentCapabilityPolicies(agentId: string, policies: CapabilityPolicyInput[]): Promise<{ policies: CapabilityPolicy[] }> {
    return this.http.request('PUT', `/api/v1/agents/${encodePathSegment(agentId)}/capability-policies`, { policies });
  }

  registrySettings(): Promise<RegistrySettings> { return this.http.request('GET', '/api/v1/registry/settings'); }
  updateRegistrySettings(input: RegistrySettings): Promise<RegistrySettings> { return this.http.request('PUT', '/api/v1/registry/settings', input); }
  registryItems(query: { q?: string; type?: RegistryItem['type'] } = {}): Promise<{ items: RegistryItem[] }> {
    const search = new URLSearchParams();
    if (query.q) search.set('q', query.q);
    if (query.type) search.set('type', query.type);
    const suffix = search.toString();
    return this.http.request('GET', `/api/v1/registry/items${suffix ? `?${suffix}` : ''}`);
  }
  registryInstallations(): Promise<{ installations: RegistryInstallation[] }> { return this.http.request('GET', '/api/v1/registry/installations'); }
  installRegistryItem(input: { itemId: string; type: RegistryItem['type']; version?: string }): Promise<RegistryInstallation> {
    return this.http.request('POST', '/api/v1/registry/install', input);
  }
  pinRegistryInstallation(id: string, version: string | null): Promise<void> {
    return this.http.request('PUT', `/api/v1/registry/installations/${encodePathSegment(id)}/pin`, { version });
  }

  federation(): Promise<{ settings: FederationSettings; connections: FederationConnection[] }> { return this.http.request('GET', '/api/v1/federation'); }
  updateFederationSettings(input: Pick<FederationSettings, 'enabled' | 'displayName'>): Promise<FederationSettings> { return this.http.request('PUT', '/api/v1/federation/settings', input); }
  createFederationConnection(input: { remoteUrl: string; scopes: string[] }): Promise<FederationConnection> { return this.http.request('POST', '/api/v1/federation/connections', input); }
  acceptFederationConnection(id: string): Promise<FederationConnection> { return this.http.request('POST', `/api/v1/federation/connections/${encodePathSegment(id)}/accept`); }
  revokeFederationConnection(id: string): Promise<FederationConnection> { return this.http.request('DELETE', `/api/v1/federation/connections/${encodePathSegment(id)}`); }
  federationEvents(id: string): Promise<{ events: FederationEvent[] }> { return this.http.request('GET', `/api/v1/federation/connections/${encodePathSegment(id)}/events`); }

  browserSessions(): Promise<{ sessions: BrowserSession[] }> { return this.http.request('GET', '/api/v1/browser/sessions'); }
  browserActions(id: string): Promise<{ actions: BrowserAction[] }> { return this.http.request('GET', `/api/v1/browser/sessions/${encodePathSegment(id)}/actions`); }
}
