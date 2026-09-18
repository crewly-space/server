import type { HttpClient } from '../http-client.js';

export type UserRole = 'owner' | 'admin' | 'member';

export interface UserAccount {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
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
}
