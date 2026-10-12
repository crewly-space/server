import type { HttpClient } from '../http-client.js';

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string | null;
  capabilities: Record<string, unknown>;
  connected: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface DevicePairingInfo {
  deviceId: string;
  deviceName: string;
  platform: string | null;
  expiresAt: string;
}

/** A folder on a device that agents may be given to work in. */
export interface DeviceWorkspace {
  id: string;
  name: string;
}

/** The workspace that was added or renamed, and all of the device's workspaces after the change. */
export interface DeviceWorkspaceChange {
  workspace: DeviceWorkspace | null;
  workspaces: DeviceWorkspace[];
}

export class DevicesResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<DeviceInfo[]> {
    return this.http.request('GET', '/api/v1/devices');
  }

  pairingByCode(code: string): Promise<DevicePairingInfo> {
    return this.http.request('GET', `/api/v1/devices/pairings/code/${encodeURIComponent(code)}`);
  }

  approvePairing(code: string): Promise<{ status: 'approved'; deviceId: string }> {
    return this.http.request('POST', `/api/v1/devices/pairings/code/${encodeURIComponent(code)}/approve`);
  }

  /** Shares a folder on one of your devices as a workspace. The device must be online; `~` means its home folder. */
  addWorkspace(deviceId: string, input: { path: string; name?: string }): Promise<DeviceWorkspaceChange> {
    return this.http.request('POST', `/api/v1/devices/${encodeURIComponent(deviceId)}/workspaces`, input);
  }

  renameWorkspace(deviceId: string, workspaceId: string, name: string): Promise<DeviceWorkspaceChange> {
    return this.http.request('PATCH', `/api/v1/devices/${encodeURIComponent(deviceId)}/workspaces/${encodeURIComponent(workspaceId)}`, { name });
  }

  /** Stops sharing the folder. Nothing on the device is deleted. */
  removeWorkspace(deviceId: string, workspaceId: string): Promise<DeviceWorkspaceChange> {
    return this.http.request('DELETE', `/api/v1/devices/${encodeURIComponent(deviceId)}/workspaces/${encodeURIComponent(workspaceId)}`);
  }
}
