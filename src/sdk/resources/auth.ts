import type { HttpClient } from '../http-client.js';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
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

  me(): Promise<AuthUser> {
    return this.http.request('GET', '/api/v1/auth/me');
  }
  status(): Promise<{ initialized: boolean; claimRequired?: boolean }> {
    return this.http.request('GET', '/api/v1/auth/status');
  }
  logout(): Promise<void> {
    return this.http.request('POST', '/api/v1/auth/logout');
  }
}
