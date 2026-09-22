import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export type SecretGranteeType = 'agent' | 'runtime' | 'mcp_server' | 'automation' | 'integration' | 'skill';

export interface SecretGrant {
  type: SecretGranteeType;
  id: string;
}

/** A secret as the API shows it: everything but the value, which never leaves the server. */
export interface Secret {
  id: string;
  name: string;
  description: string;
  version: number;
  revoked: boolean;
  grants: SecretGrant[];
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
}

export interface SecretDependent {
  type: string;
  id: string;
  name: string;
  via: 'grant' | 'reference';
}

export interface SecretAuditEntry {
  id: string;
  secretId: string;
  secretName: string;
  action: string;
  actor: { type: string; id: string | null };
  detail: Record<string, unknown>;
  at: string;
}

/** The server's secrets vault. Owners and admins only. */
export class SecretsResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<{ secrets: Secret[] }> {
    return this.http.request('GET', '/api/v1/secrets');
  }

  create(input: { name: string; value: string; description?: string }): Promise<Secret> {
    return this.http.request('POST', '/api/v1/secrets', input);
  }

  /** A rename that would orphan references fails with `secret_in_use` unless forced. */
  update(id: string, input: { name?: string; description?: string }, options: { force?: boolean } = {}): Promise<Secret> {
    return this.http.request('PATCH', `/api/v1/secrets/${encodePathSegment(id)}${options.force ? '?force=true' : ''}`, input);
  }

  rotate(id: string, value: string): Promise<Secret> {
    return this.http.request('PUT', `/api/v1/secrets/${encodePathSegment(id)}/value`, { value });
  }

  revoke(id: string): Promise<Secret> {
    return this.http.request('POST', `/api/v1/secrets/${encodePathSegment(id)}/revoke`);
  }

  setGrants(id: string, grants: SecretGrant[]): Promise<Secret> {
    return this.http.request('PUT', `/api/v1/secrets/${encodePathSegment(id)}/grants`, { grants });
  }

  dependents(id: string): Promise<{ dependents: SecretDependent[] }> {
    return this.http.request('GET', `/api/v1/secrets/${encodePathSegment(id)}/dependents`);
  }

  /** Fails with `secret_in_use` and the dependents unless forced. */
  delete(id: string, options: { force?: boolean } = {}): Promise<void> {
    return this.http.request('DELETE', `/api/v1/secrets/${encodePathSegment(id)}${options.force ? '?force=true' : ''}`);
  }

  audit(filter: { secretId?: string; limit?: number } = {}): Promise<{ entries: SecretAuditEntry[] }> {
    const query = new URLSearchParams();
    if (filter.secretId) query.set('secretId', filter.secretId);
    if (filter.limit) query.set('limit', String(filter.limit));
    const suffix = query.toString();
    return this.http.request('GET', `/api/v1/secrets/audit${suffix ? `?${suffix}` : ''}`);
  }
}
