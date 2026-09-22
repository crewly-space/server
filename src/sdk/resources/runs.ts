import type { AgentRun, AgentRunStatus } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';
import type { ProviderCall } from './usage.js';

/** One step of a run: a provider call, a retry, a fallback, a tool call, a state change. */
export interface RunEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export interface RunTreeNode {
  runId: string;
  causationId: string | null;
  hopCount: number;
  agentId: string;
  agentName: string | null;
  status: AgentRunStatus | undefined;
  trigger: string | undefined;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunSummary {
  durationMs: number | null;
  provider: { providerId: string; model: string } | null;
  providerCalls: number;
  retries: number;
  fallbacks: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  unpricedCalls: number;
}

/** Everything the inspector shows about one run. Metadata only: no prompt, reply or tool content. */
export interface RunTrace {
  run: AgentRun & { agentName: string | null };
  summary: RunSummary;
  events: RunEvent[];
  providerCalls: ProviderCall[];
  approvals: Array<{ id: string; action: string; status: string; createdAt: string; resolvedAt: string | null }>;
  runtimeSessions: Array<{ id: string; runtimeKind: string; workspacePath: string; status: string; updatedAt: string }>;
  tree: RunTreeNode[];
  treeCostMicros: number;
}

export class RunsResource {
  constructor(private readonly http: HttpClient) {}

  /** Admins may list any runs; others must name a conversation they are in. */
  list(filter: { status?: AgentRunStatus; agentId?: string; conversationId?: string; limit?: number } = {}): Promise<{ runs: AgentRun[] }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value !== undefined) query.set(key, String(value));
    const suffix = query.toString();
    return this.http.request('GET', `/api/v1/runs${suffix ? `?${suffix}` : ''}`);
  }

  get(runId: string): Promise<RunTrace> {
    return this.http.request('GET', `/api/v1/runs/${encodePathSegment(runId)}`);
  }

  /** The run that wrote a message, or that the message started. */
  forMessage(messageId: string): Promise<RunTrace> {
    return this.http.request('GET', `/api/v1/messages/${encodePathSegment(messageId)}/run`);
  }

  /** Cancels a run and everything it delegated; returns the runs that were stopped. */
  cancel(runId: string): Promise<{ cancelled: string[] }> {
    return this.http.request('POST', `/api/v1/runs/${encodePathSegment(runId)}/cancel`);
  }
}
