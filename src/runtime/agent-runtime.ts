import { randomUUID } from 'node:crypto';
import type { Agent, RuntimeKind } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import type { DeviceConnectionHub } from '../devices/hub.js';
import { listDevicesForUser, type DeviceRecord } from '../devices/repository.js';

/**
 * The runtime options a person may set, and their allowed values. Anything
 * else in a binding is the runtime's own session state and is neither shown
 * nor editable.
 */
export const RUNTIME_OPTIONS = {
  /** How much the coding runtime may do without asking. */
  permissionMode: ['ask', 'auto_edit', 'read_only'],
} as const;

export type RuntimeOptions = { permissionMode: (typeof RUNTIME_OPTIONS.permissionMode)[number] };
const DEFAULT_OPTIONS: RuntimeOptions = { permissionMode: 'ask' };

export class RuntimeConfigError extends Error {}

interface DeviceCapabilities {
  runtimes?: Array<{ id?: string; name?: string; authenticated?: boolean }>;
  workspaces?: Array<{ id?: string; name?: string }>;
}

function capabilitiesOf(device: DeviceRecord): Required<DeviceCapabilities> {
  try {
    const parsed = JSON.parse(device.capabilities) as DeviceCapabilities;
    return { runtimes: parsed.runtimes ?? [], workspaces: parsed.workspaces ?? [] };
  } catch {
    return { runtimes: [], workspaces: [] };
  }
}

export interface RuntimeDevice {
  id: string;
  name: string;
  connected: boolean;
  lastSeenAt: string | null;
  runtimes: Array<{ id: string; name: string; authenticated: boolean }>;
  workspaces: Array<{ id: string; name: string }>;
}

export interface AgentRuntimeView {
  runtimeKind: RuntimeKind;
  binding: {
    id: string;
    deviceId: string | null;
    deviceName: string | null;
    workspaceId: string | null;
    workspaceName: string;
    options: RuntimeOptions;
    updatedAt: string;
  } | null;
  /** Whether the runtime can run right now, and if not, what is missing. */
  health: { available: boolean; reason: string | null };
  sessions: Array<{ id: string; conversationId: string; status: string; updatedAt: string }>;
  /** The owner's paired devices, with what each can run, for choosing a binding. */
  devices: RuntimeDevice[];
}

interface BindingRow {
  id: string;
  runtime_kind: RuntimeKind;
  workspace_path: string;
  device_id: string | null;
  workspace_id: string | null;
  options: string;
  updated_at: string;
}

const LABELS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI' };

function currentBinding(db: Database, agentId: string): BindingRow | undefined {
  return db
    .prepare('SELECT * FROM runtime_bindings WHERE agent_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1')
    .get(agentId) as BindingRow | undefined;
}

function devicesFor(db: Database, hub: DeviceConnectionHub | undefined, ownerUserId: string): RuntimeDevice[] {
  return listDevicesForUser(db, ownerUserId).map((device) => {
    const capabilities = capabilitiesOf(device);
    return {
      id: device.id,
      name: device.name,
      connected: hub?.isConnected(device.id) ?? false,
      lastSeenAt: device.last_seen_at,
      runtimes: capabilities.runtimes
        .filter((runtime) => runtime.id)
        .map((runtime) => ({ id: runtime.id!, name: runtime.name ?? LABELS[runtime.id!] ?? runtime.id!, authenticated: runtime.authenticated !== false })),
      workspaces: capabilities.workspaces
        .filter((workspace) => workspace.id)
        .map((workspace) => ({ id: workspace.id!, name: workspace.name ?? workspace.id! })),
    };
  });
}

/**
 * Whether a coding runtime can run for this agent now, and why not: judged on
 * the bound device when there is one, else on any of the owner's devices.
 */
export function runtimeHealth(
  db: Database,
  hub: DeviceConnectionHub | undefined,
  ownerUserId: string,
  runtime: string,
  deviceId: string | null,
): { available: boolean; reason: string | null } {
  if (runtime === 'native') return { available: true, reason: null };
  const label = LABELS[runtime] ?? runtime;
  const candidates = devicesFor(db, hub, ownerUserId).filter((device) => !deviceId || device.id === deviceId);
  if (candidates.length === 0) return { available: false, reason: deviceId ? 'The bound device is no longer paired' : 'No paired device' };
  const offering = candidates.filter((device) => device.runtimes.some((entry) => entry.id === runtime));
  if (offering.length === 0) return { available: false, reason: `${label} is not installed on ${deviceId ? candidates[0]!.name : 'any paired device'}` };
  const signedIn = offering.filter((device) => device.runtimes.some((entry) => entry.id === runtime && entry.authenticated));
  if (signedIn.length === 0) return { available: false, reason: `${label} is installed but not signed in` };
  if (!signedIn.some((device) => device.connected)) return { available: false, reason: `${signedIn[0]!.name} is offline` };
  return { available: true, reason: null };
}

export function agentRuntime(db: Database, hub: DeviceConnectionHub | undefined, agent: Agent): AgentRuntimeView {
  const binding = currentBinding(db, agent.id);
  const devices = devicesFor(db, hub, agent.ownerUserId);
  const kind = binding?.runtime_kind ?? 'native';
  const device = binding?.device_id ? devices.find((candidate) => candidate.id === binding.device_id) : undefined;
  return {
    runtimeKind: kind,
    binding: binding
      ? {
          id: binding.id,
          deviceId: binding.device_id,
          deviceName: device?.name ?? null,
          workspaceId: binding.workspace_id,
          workspaceName: binding.workspace_path,
          options: { ...DEFAULT_OPTIONS, ...(JSON.parse(binding.options) as Partial<RuntimeOptions>) },
          updatedAt: binding.updated_at,
        }
      : null,
    health: runtimeHealth(db, hub, agent.ownerUserId, kind, binding?.device_id ?? null),
    sessions: (db
      .prepare('SELECT id, conversation_id, status, updated_at FROM runtime_sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 20')
      .all(agent.id) as Array<{ id: string; conversation_id: string; status: string; updated_at: string }>)
      .map((row) => ({ id: row.id, conversationId: row.conversation_id, status: row.status, updatedAt: row.updated_at })),
    devices,
  };
}

/**
 * Points an agent at a runtime. A coding runtime needs one of the owner's
 * devices that has it installed, and one of that device's workspaces; the
 * native runtime needs neither. Earlier bindings are kept, since runtime
 * sessions refer to them -- the newest one is the agent's runtime.
 */
export function setAgentRuntime(
  db: Database,
  agent: Agent,
  input: { runtimeKind: RuntimeKind; deviceId?: string; workspaceId?: string; options?: Partial<RuntimeOptions> },
): void {
  const options: RuntimeOptions = { ...DEFAULT_OPTIONS, ...input.options };
  if (!RUNTIME_OPTIONS.permissionMode.includes(options.permissionMode)) throw new RuntimeConfigError('Unknown permission mode');
  const now = new Date().toISOString();
  if (input.runtimeKind === 'native') {
    db.prepare(
      `INSERT INTO runtime_bindings (id, agent_id, runtime_kind, workspace_path, vendor_state, device_id, workspace_id, options, created_at, updated_at)
       VALUES (?, ?, 'native', '-', '{}', NULL, NULL, ?, ?, ?)`,
    ).run(randomUUID(), agent.id, JSON.stringify(options), now, now);
    return;
  }
  const label = LABELS[input.runtimeKind] ?? input.runtimeKind;
  if (!input.deviceId) throw new RuntimeConfigError(`${label} runs on a paired device: choose one`);
  const device = listDevicesForUser(db, agent.ownerUserId).find((candidate) => candidate.id === input.deviceId);
  if (!device) throw new RuntimeConfigError("That device is not one of the agent owner's paired devices");
  const capabilities = capabilitiesOf(device);
  if (!capabilities.runtimes.some((runtime) => runtime.id === input.runtimeKind)) {
    throw new RuntimeConfigError(`${label} is not installed on ${device.name}. Run \`crewly runtime install\` there.`);
  }
  const workspace = capabilities.workspaces.find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) {
    throw new RuntimeConfigError(`Choose one of ${device.name}'s workspaces. Add one there with \`crewly workspace add <path>\`.`);
  }
  db.prepare(
    `INSERT INTO runtime_bindings (id, agent_id, runtime_kind, workspace_path, vendor_state, device_id, workspace_id, options, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), agent.id, input.runtimeKind, workspace.name ?? workspace.id, device.id, workspace.id, JSON.stringify(options), now, now);
}
