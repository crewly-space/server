import type { HttpClient } from '../http-client.js';

export type UserRole = 'owner' | 'admin' | 'member';

export interface UserAccount {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  /** Set while their access is withdrawn; null when they may use the server. */
  suspendedAt?: string | null;
}

/** An invitation to join this server. The code is returned only when it is made. */
export interface Invite {
  id: string;
  role: Exclude<UserRole, 'owner'>;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  label: string | null;
  code?: string;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  password: string;
  role?: Exclude<UserRole, 'owner'>;
}

export class UsersResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<UserAccount[]> {
    return this.http.request('GET', '/api/v1/users');
  }

  create(input: CreateUserInput): Promise<UserAccount> {
    return this.http.request('POST', '/api/v1/users', input);
  }

  setRole(id: string, role: UserRole): Promise<UserAccount> {
    return this.http.request('PATCH', `/api/v1/users/${encodeURIComponent(id)}`, { role });
  }

  /** Withdraws access, or gives it back. Suspending also ends their sessions. */
  setSuspended(id: string, suspended: boolean): Promise<UserAccount> {
    return this.http.request('PUT', `/api/v1/users/${encodeURIComponent(id)}/suspension`, { suspended });
  }

  remove(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/users/${encodeURIComponent(id)}`);
  }

  listInvites(): Promise<{ invites: Invite[] }> {
    return this.http.request('GET', '/api/v1/invites');
  }

  /** The reply carries the code. It is stored hashed, so this is the only time it is readable. */
  createInvite(input: { role?: Exclude<UserRole, 'owner'>; label?: string } = {}): Promise<{ invite: Invite }> {
    return this.http.request('POST', '/api/v1/invites', input);
  }

  revokeInvite(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/invites/${encodeURIComponent(id)}`);
  }

  acceptInvite(code: string, input: { email: string; displayName: string; password: string }): Promise<{
    token: string;
    user: UserAccount;
  }> {
    return this.http.request('POST', `/api/v1/invites/${encodeURIComponent(code)}/accept`, input);
  }
}
