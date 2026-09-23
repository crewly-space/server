import type { HttpClient } from '../http-client.js';

/** This server's optional connection to a Crewly account. Never includes the credential. */
export interface CrewlyConnection {
  status: 'disconnected' | 'pending' | 'connected' | 'revoked';
  cloudUrl: string | null;
  instanceId: string | null;
  scopes: string[];
  credentialVersion: number | null;
  connectedAt: string | null;
  lastCheckedAt: string | null;
  /** While pending: the code the owner approves in Crewly, and where. */
  link: { userCode: string; verificationUrl: string; expiresAt: string; interval: number } | null;
}

export interface CrewlyAuditEntry {
  id: string;
  action: string;
  actor: { type: 'user' | 'system'; id: string | null };
  detail: Record<string, unknown>;
  at: string;
}

/** Connect Crewly: link this server to a Crewly account for managed services. Owners and admins only. */
export class CrewlyResource {
  constructor(private readonly http: HttpClient) {}

  get(): Promise<CrewlyConnection> {
    return this.http.request('GET', '/api/v1/server/crewly');
  }

  /** Starts a link; open `link.verificationUrl` and approve, then `poll()` every `link.interval` seconds. */
  connect(input: { name?: string; scopes?: string[] } = {}): Promise<CrewlyConnection> {
    return this.http.request('POST', '/api/v1/server/crewly/connect', input);
  }

  poll(): Promise<CrewlyConnection> {
    return this.http.request('POST', '/api/v1/server/crewly/connect/poll');
  }

  refresh(): Promise<CrewlyConnection> {
    return this.http.request('POST', '/api/v1/server/crewly/refresh');
  }

  rotate(): Promise<CrewlyConnection> {
    return this.http.request('POST', '/api/v1/server/crewly/credential/rotate');
  }

  disconnect(): Promise<{ notifiedCrewly: boolean }> {
    return this.http.request('DELETE', '/api/v1/server/crewly');
  }

  audit(limit = 100): Promise<{ entries: CrewlyAuditEntry[] }> {
    return this.http.request('GET', `/api/v1/server/crewly/audit?limit=${limit}`);
  }
}
