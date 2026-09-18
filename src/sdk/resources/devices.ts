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
}
