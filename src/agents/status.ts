import type { Agent, AgentExecutionState, AgentPresence, AgentStatus } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import type { DeviceConnectionHub } from '../devices/hub.js';
import { providerHealth } from '../gateway/health.js';
import type { RateLimitBoard } from '../gateway/rate-limits.js';
import { getProviderConfig } from '../providers/repository.js';
import type { ConnectionHub } from '../ws/hub.js';
import { getAgent, listAllAgents } from './repository.js';
import { runtimeHealth } from '../runtime/agent-runtime.js';

/** The realtime topic every signed-in socket hears agent status on. */
export const AGENT_STATUS_TOPIC = 'agents';

/** An agent that finished something this recently is online rather than idle. */
const IDLE_AFTER_MS = 15 * 60 * 1000;

export interface StatusSources {
  deviceHub?: DeviceConnectionHub;
  rateLimits?: RateLimitBoard;
  now?: number;
}

/** The reason a provider cannot serve an agent, or null when it can. */
function providerProblem(db: Database, agent: Agent, sources: StatusSources): string | null {
  const config = getProviderConfig(db, agent.modelPolicy.defaultProviderId);
  if (!config) return 'No model provider is configured';
  const health = providerHealth(db, config, { deviceHub: sources.deviceHub, rateLimits: sources.rateLimits, now: sources.now });
  if (health.status !== 'down') return null;
  if (health.deviceConnected === false) {
    return config.kind === 'claude-subscription' ? 'Claude device offline' : `${config.kind} device offline`;
  }
  if (health.lastError?.code === 'provider_auth_failed') return 'Provider rejected its API key';
  return health.reason ?? 'Provider unavailable';
}

/**
 * An agent's canonical status, derived from what the server actually knows:
 * its runs, pending approvals, provider health, and the devices and runtimes
 * it depends on. Nothing here is a guess from whether a setting exists.
 */
export function computeAgentStatus(db: Database, agent: Agent, sources: StatusSources = {}): AgentStatus {
  const now = sources.now ?? Date.now();
  const active = db
    .prepare(
      `SELECT run_id, status FROM agent_runs WHERE agent_id = ? AND status IN ('running', 'queued')
       ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
    )
    .get(agent.id) as { run_id: string; status: 'running' | 'queued' } | undefined;
  const approval = db
    .prepare("SELECT run_id FROM approvals WHERE agent_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1")
    .get(agent.id) as { run_id: string } | undefined;
  const last = db
    .prepare(
      `SELECT status, error_code, COALESCE(finished_at, created_at) AS at FROM agent_runs
       WHERE agent_id = ? AND status IN ('completed', 'failed') ORDER BY COALESCE(finished_at, created_at) DESC, rowid DESC LIMIT 1`,
    )
    .get(agent.id) as { status: 'completed' | 'failed'; error_code: string | null; at: string } | undefined;
  const binding = db
    .prepare('SELECT runtime_kind, device_id FROM runtime_bindings WHERE agent_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1')
    .get(agent.id) as { runtime_kind: string; device_id: string | null } | undefined;

  let execution: AgentExecutionState = 'ready';
  let reason: string | null = null;
  let activeRunId: string | null = null;

  const problem = providerProblem(db, agent, sources);
  const runtime = binding && binding.runtime_kind !== 'native' ? binding.runtime_kind : null;
  if (approval) {
    execution = 'waiting_approval';
    reason = 'Waiting for approval';
    activeRunId = approval.run_id;
  } else if (active?.status === 'running') {
    execution = 'working';
    activeRunId = active.run_id;
  } else if (active?.status === 'queued') {
    execution = 'queued';
    reason = 'Queued behind another run';
    activeRunId = active.run_id;
  } else if (problem) {
    execution = 'provider_unavailable';
    reason = problem;
  } else if (runtime && !runtimeHealth(db, sources.deviceHub, agent.ownerUserId, runtime, binding?.device_id ?? null).available) {
    execution = 'runtime_unavailable';
    reason = runtimeHealth(db, sources.deviceHub, agent.ownerUserId, runtime, binding?.device_id ?? null).reason;
  } else if (last?.status === 'failed') {
    execution = 'error';
    reason = last.error_code ? `Last run failed: ${last.error_code}` : 'Last run failed';
  }

  const lastActiveAt = last?.at ?? null;
  let presence: AgentPresence;
  if (agent.availability === 'dnd') presence = 'dnd';
  else if (execution === 'provider_unavailable' || execution === 'runtime_unavailable') presence = 'offline';
  else if (activeRunId || (lastActiveAt && now - Date.parse(lastActiveAt) < IDLE_AFTER_MS)) presence = 'online';
  else presence = 'idle';

  return { agentId: agent.id, presence, execution, reason, availability: agent.availability, activeRunId, lastActiveAt };
}

/**
 * Whether automatic routing (relevance, delegation, automations) may wake the
 * agent. A person addressing it directly -- a DM or a mention -- always can.
 */
export function canAutoInvoke(status: AgentStatus): boolean {
  return status.presence !== 'dnd' && status.presence !== 'offline';
}

/**
 * Publishes an agent's status whenever it changes, and only then.
 *
 * Anything that might move a status -- a run starting or ending, an approval,
 * a device coming or going, a provider edit -- calls `refresh`. The status is
 * recomputed from the database and published on the `agents` topic when it
 * differs from the last one sent, so the event log carries transitions rather
 * than noise, and a reconnecting client replays exactly those.
 */
export class AgentStatusBroadcaster {
  private readonly last = new Map<string, string>();

  constructor(
    private readonly db: Database,
    private readonly hub: ConnectionHub,
    private readonly sources: () => StatusSources,
  ) {}

  status(agentId: string): AgentStatus | undefined {
    const agent = getAgent(this.db, agentId);
    return agent ? computeAgentStatus(this.db, agent, this.sources()) : undefined;
  }

  all(): AgentStatus[] {
    const sources = this.sources();
    return listAllAgents(this.db).map((agent) => computeAgentStatus(this.db, agent, sources));
  }

  /** Recompute one agent, or every agent when a shared dependency (a device, a provider) changed. */
  refresh(agentId?: string): AgentStatus[] {
    const statuses = agentId ? [this.status(agentId)].filter((s): s is AgentStatus => Boolean(s)) : this.all();
    const changed: AgentStatus[] = [];
    for (const status of statuses) {
      // lastActiveAt moves on every run; it is carried, but not a reason to announce.
      const key = JSON.stringify({ ...status, lastActiveAt: undefined });
      if (this.last.get(status.agentId) === key) continue;
      this.last.set(status.agentId, key);
      this.hub.publish(AGENT_STATUS_TOPIC, 'agent.status', { ...status });
      changed.push(status);
    }
    return changed;
  }
}
