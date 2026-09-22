import type { Agent, AgentStatus, ModelPolicy } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface CreateAgentInput {
  name: string;
  personality?: string;
  modelPolicy: ModelPolicy;
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
}
