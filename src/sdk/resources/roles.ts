import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export type PermissionId =
  | 'members.view' | 'members.manage' | 'members.invite'
  | 'agents.create' | 'agents.manage' | 'providers.manage'
  | 'integrations.manage' | 'server.settings' | 'operations.view' | 'roles.manage';

export interface PermissionDefinition {
  id: PermissionId;
  label: string;
  description: string;
  group: 'People' | 'Workspace' | 'Services' | 'Server';
}

export interface ServerRole {
  id: string;
  name: string;
  description: string;
  permissions: PermissionId[];
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RolesCatalog {
  permissions: PermissionDefinition[];
  roles: ServerRole[];
  members: Array<{ userId: string; roles: string[] }>;
}

export interface RoleInput {
  name: string;
  description?: string;
  permissions: PermissionId[];
}

export class RolesResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<RolesCatalog> {
    return this.http.request('GET', '/api/v1/roles');
  }

  create(input: RoleInput): Promise<ServerRole> {
    return this.http.request('POST', '/api/v1/roles', input);
  }

  update(id: string, input: RoleInput): Promise<ServerRole> {
    return this.http.request('PATCH', `/api/v1/roles/${encodePathSegment(id)}`, input);
  }

  remove(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/roles/${encodePathSegment(id)}`);
  }

  assign(roleId: string, userId: string): Promise<void> {
    return this.http.request('PUT', `/api/v1/roles/${encodePathSegment(roleId)}/members/${encodePathSegment(userId)}`);
  }

  unassign(roleId: string, userId: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/roles/${encodePathSegment(roleId)}/members/${encodePathSegment(userId)}`);
  }
}
