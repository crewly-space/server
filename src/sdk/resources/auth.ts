import type { HttpClient } from '../http-client.js';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  /** Returned by /auth/me; absent from a login or setup reply. */
  displayName?: string;
  avatarMode?: 'bloop' | 'blobatar' | 'name';
}

export interface AuthResult {
  token: string;
  user: AuthUser;
}

export interface AuthSetupInput {
  email: string;
  displayName: string;
  password: string;
  claimToken?: string;
}

export interface AuthLoginInput {
  email: string;
  password: string;
}

export class AuthResource {
  constructor(private readonly http: HttpClient) {}

  setup(input: AuthSetupInput): Promise<AuthResult> {
    return this.http.request('POST', '/api/v1/auth/setup', input);
  }

  login(input: AuthLoginInput): Promise<AuthResult> {
    return this.http.request('POST', '/api/v1/auth/login', input);
  }

  /**
   * Trades a Crewly Cloud handoff token for a session on this server.
   *
   * Only servers linked to a Cloud answer this; a self-hosted one replies 404,
   * which is why `status()` says whether to offer it.
   */
  cloudHandoff(input: { token: string }): Promise<AuthResult> {
    return this.http.request('POST', '/api/v1/auth/cloud-handoff', input);
  }

  me(): Promise<AuthUser> {
    return this.http.request('GET', '/api/v1/auth/me');
  }
  status(): Promise<{ initialized: boolean; claimRequired?: boolean; cloudHandoff?: boolean }> {
    return this.http.request('GET', '/api/v1/auth/status');
  }
  logout(): Promise<void> {
    return this.http.request('POST', '/api/v1/auth/logout');
  }
}
