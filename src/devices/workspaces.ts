import type { Database } from '../db/driver.js';
import { DeviceCapabilityError, DeviceRequestError, DeviceUnavailableError, type DeviceConnectionHub } from './hub.js';
import { listDevicesForUser, touchDevice } from './repository.js';

export class DeviceWorkspaceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export interface DeviceWorkspace { id: string; name: string }

export type WorkspaceChange =
  | { action: 'add'; path: string; name?: string }
  | { action: 'update'; workspaceId: string; name: string }
  | { action: 'remove'; workspaceId: string };

function workspacesOf(capabilities: unknown): DeviceWorkspace[] {
  const list = (capabilities as { workspaces?: Array<{ id?: unknown; name?: unknown }> } | null)?.workspaces ?? [];
  return list
    .filter((workspace) => typeof workspace.id === 'string')
    .map((workspace) => ({ id: workspace.id as string, name: typeof workspace.name === 'string' ? workspace.name : workspace.id as string }));
}

/*
 * Adds, renames or removes a workspace on one of the requester's own devices,
 * so choosing what an agent may work on does not need a terminal.
 *
 * The device stays in charge: it resolves the path itself, refuses anything
 * that is not a directory it is willing to share, and answers with its fresh
 * capabilities, which are stored at once so the app sees the change without
 * waiting for the next heartbeat. Bindings remember a workspace by name, so a
 * rename is carried over to them.
 */
export async function changeDeviceWorkspace(
  db: Database,
  hub: DeviceConnectionHub,
  ownerUserId: string,
  deviceId: string,
  change: WorkspaceChange,
): Promise<{ workspace: DeviceWorkspace | null; workspaces: DeviceWorkspace[] }> {
  const device = listDevicesForUser(db, ownerUserId).find((candidate) => candidate.id === deviceId);
  if (!device) throw new DeviceWorkspaceError(404, 'device_not_found', 'That device is not one of yours');
  const outdated = new DeviceWorkspaceError(409, 'device_outdated',
    `${device.name} runs an older crewly. Run \`crewly update\` there to manage its workspaces from here.`);
  if (!hub.isConnected(device.id)) {
    throw new DeviceWorkspaceError(409, 'device_offline', `${device.name} is offline. Start it with \`crewly start\` there, then try again.`);
  }
  const { action, ...payload } = change;
  let result: Record<string, unknown>;
  try {
    result = await hub.request(device.id, `workspace.${action}`, payload, 15_000, { requiredCapability: 'agentd.capabilities.v1' });
  } catch (error) {
    if (error instanceof DeviceRequestError) {
      // An older device rejects an operation it does not know as malformed.
      if (error.code === 'invalid_request' || error.code === 'operation_unavailable') throw outdated;
      throw new DeviceWorkspaceError(400, error.code, error.message);
    }
    if (error instanceof DeviceCapabilityError) throw outdated;
    if (error instanceof DeviceUnavailableError) {
      throw new DeviceWorkspaceError(409, 'device_offline', `${device.name} did not answer. Check it is online and try again.`);
    }
    throw error;
  }
  const capabilities = result.capabilities && typeof result.capabilities === 'object' ? result.capabilities as Record<string, unknown> : null;
  if (capabilities) touchDevice(db, device.id, capabilities);
  const workspaces = workspacesOf(capabilities ?? JSON.parse(device.capabilities));
  const workspace = workspacesOf({ workspaces: [result.workspace ?? {}] })[0] ?? null;
  if (change.action === 'update' && workspace) {
    db.prepare('UPDATE runtime_bindings SET workspace_path = ? WHERE device_id = ? AND workspace_id = ?').run(workspace.name, device.id, workspace.id);
  }
  return { workspace, workspaces };
}
