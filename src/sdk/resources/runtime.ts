import type { AgentRun, Message, RuntimeBinding, RuntimeKind, RuntimeSession } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface AgentTurnOutcome {
  run: AgentRun;
  message: Message;
  handoff: { attempted: boolean; dispatched: boolean; blockedReason?: 'max_hop_count_exceeded' };
}

export interface CreateRuntimeBindingInput {
  agentId: string;
  runtimeKind: RuntimeKind;
  workspacePath: string;
}

export interface CreateRuntimeSessionInput {
  agentId: string;
  conversationId: string;
  runtimeBindingId: string;
}

export interface InvokeAgentInput {
  conversationId: string;
}

export class RuntimeResource {
  constructor(private readonly http: HttpClient) {}

  createBinding(input: CreateRuntimeBindingInput): Promise<RuntimeBinding> {
    return this.http.request('POST', '/api/v1/runtime-bindings', input);
  }

  getBinding(id: string): Promise<RuntimeBinding> {
    return this.http.request('GET', `/api/v1/runtime-bindings/${encodePathSegment(id)}`);
  }

  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession> {
    return this.http.request('POST', '/api/v1/runtime-sessions', input);
  }

  getSession(id: string): Promise<RuntimeSession> {
    return this.http.request('GET', `/api/v1/runtime-sessions/${encodePathSegment(id)}`);
  }

  invokeAgent(agentId: string, input: InvokeAgentInput): Promise<AgentTurnOutcome> {
    return this.http.request('POST', `/api/v1/agents/${encodePathSegment(agentId)}/runs`, input);
  }
}
