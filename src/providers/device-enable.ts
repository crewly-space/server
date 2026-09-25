import type { ProviderKind } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { listDevicesForUser, touchDevice } from '../devices/repository.js';
import { DeviceRequestError, type DeviceConnectionHub } from '../devices/hub.js';

export interface DeviceEnableOutcome {
  deviceId: string;
  deviceName: string;
  enabled: boolean;
  /** The device's reason when it refused: runtime_missing, provider_sign_in_expired, ... */
  error?: string;
}

function advertises(capabilities: string, kind: string): boolean {
  try {
    const parsed = JSON.parse(capabilities) as { providers?: Array<{ kind?: unknown }> };
    return parsed.providers?.some((provider) => provider.kind === kind) ?? false;
  } catch {
    return false;
  }
}

/*
 * Turns on a subscription- or device-backed provider on the person's own
 * paired devices, so "Connect Claude" works without a terminal.
 *
 * Only the requester's devices are asked: connecting a provider must never
 * start routing work through somebody else's subscription. Each device
 * decides for itself -- it checks that Claude Code is installed and signed in,
 * or that Ollama answers -- and no credential crosses the wire; the device
 * only adds the provider to its own configuration. Its reply carries its
 * fresh capabilities, stored at once so the app sees the provider without
 * waiting for the next heartbeat.
 */
export async function enableOnDevices(
  db: Database,
  hub: DeviceConnectionHub,
  ownerUserId: string,
  kind: ProviderKind,
): Promise<DeviceEnableOutcome[]> {
  const candidates = listDevicesForUser(db, ownerUserId)
    .filter((device) => hub.isConnected(device.id) && !advertises(device.capabilities, kind));
  return Promise.all(candidates.map(async (device): Promise<DeviceEnableOutcome> => {
    try {
      const result = await hub.request(device.id, 'provider.enable', { kind }, 15_000, {
        requiredCapability: 'agentd.capabilities.v1',
      });
      if (result.capabilities && typeof result.capabilities === 'object') {
        touchDevice(db, device.id, result.capabilities as Record<string, unknown>);
      }
      return { deviceId: device.id, deviceName: device.name, enabled: result.enabled === true };
    } catch (error) {
      return {
        deviceId: device.id,
        deviceName: device.name,
        enabled: false,
        error: error instanceof DeviceRequestError ? error.code : 'device_unavailable',
      };
    }
  }));
}
