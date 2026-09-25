import type { Agent, AgentRoutingMode, AgentStatus, AvatarMode, ModelPolicy, RuntimeKind } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface CreateAgentInput {
  name: string;
  personality?: string;
  modelPolicy: ModelPolicy;
  /** How the agent is drawn. Left out on update, it keeps the one it had. */
  avatarMode?: AvatarMode;
}

export type RuntimePermissionMode = 'ask' | 'auto_edit' | 'read_only';

/** What an agent runs on, whether it can run now, and the devices it could run on. */
export interface AgentRuntime {
  runtimeKind: RuntimeKind;
  binding: {
    id: string;
    deviceId: string | null;
    deviceName: string | null;
    workspaceId: string | null;
    workspaceName: string;
    options: { permissionMode: RuntimePermissionMode };
    updatedAt: string;
  } | null;
  health: { available: boolean; reason: string | null };
  sessions: Array<{ id: string; conversationId: string; status: string; updatedAt: string }>;
  devices: Array<{
    id: string;
    name: string;
    connected: boolean;
    lastSeenAt: string | null;
    runtimes: Array<{ id: string; name: string; authenticated: boolean }>;
    workspaces: Array<{ id: string; name: string }>;
  }>;
}

export interface SetAgentRuntimeInput {
  runtimeKind: RuntimeKind;
  deviceId?: string;
  workspaceId?: string;
  options?: { permissionMode?: RuntimePermissionMode };
}

export interface AgentRoutingOverride {
  conversationId: string;
  conversationName: string;
  mode: AgentRoutingMode;
}

export interface AgentRoutingConfig {
  defaultMode: AgentRoutingMode;
  overrides: AgentRoutingOverride[];
}

export class AgentsResource {
  constructor(private readonly http: HttpClient) {}

  create(input: CreateAgentInput): Promise<Agent> {
    return this.http.request('POST', '/api/v1/agents', input);
  }

  list(): Promise<Agent[]> {
    return this.http.request('GET', '/api/v1/agents');
  }
  update(id: string, input: CreateAgentInput): Promise<Agent> {
    return this.http.request('PATCH', `/api/v1/agents/${encodePathSegment(id)}`, input);
  }

  /** Every agent's canonical status. Changes arrive live as `agent.status` on the `agents` topic. */
  statuses(): Promise<{ statuses: AgentStatus[] }> {
    return this.http.request('GET', '/api/v1/agents/status');
  }

  status(id: string): Promise<AgentStatus> {
    return this.http.request('GET', `/api/v1/agents/${encodePathSegment(id)}/status`);
  }

  runtime(id: string): Promise<AgentRuntime> {
    return this.http.request('GET', `/api/v1/agents/${encodePathSegment(id)}/runtime`);
  }

  /** A coding runtime needs a paired device that has it, and one of that device's workspaces. */
  setRuntime(id: string, input: SetAgentRuntimeInput): Promise<AgentRuntime> {
    return this.http.request('PUT', `/api/v1/agents/${encodePathSegment(id)}/runtime`, input);
  }

  /** The agents this one may hand subtasks to with its `delegate_to_agent` tool. */
  delegates(id: string): Promise<{ delegates: Array<{ agentId: string; name: string }> }> {
    return this.http.request('GET', `/api/v1/agents/${encodePathSegment(id)}/delegates`);
  }

  setDelegates(id: string, agentIds: string[]): Promise<{ delegates: Array<{ agentId: string; name: string }> }> {
    return this.http.request('PUT', `/api/v1/agents/${encodePathSegment(id)}/delegates`, { agentIds });
  }

  /** `dnd` keeps the agent out of automatic invocation; `auto` returns presence to what it is doing. */
  setAvailability(id: string, availability: 'auto' | 'dnd'): Promise<AgentStatus> {
    return this.http.request('PUT', `/api/v1/agents/${encodePathSegment(id)}/availability`, { availability });
  }

  routing(id: string): Promise<AgentRoutingConfig> {
    return this.http.request('GET', `/api/v1/agents/${encodePathSegment(id)}/routing`);
  }

  setRouting(id: string, input: { mode: AgentRoutingMode | 'inherit'; conversationId?: string | null }): Promise<AgentRoutingConfig> {
    return this.http.request('PUT', `/api/v1/agents/${encodePathSegment(id)}/routing`, {
      mode: input.mode,
      conversationId: input.conversationId ?? null,
    });
  }
}
