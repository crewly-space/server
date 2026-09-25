import type { HttpClient } from '../http-client.js';

export type AutomationTriggerType = 'webhook' | 'message' | 'schedule' | 'run';
export type AutomationAction =
  | { type: 'post_message'; conversationId?: string; body: string }
  | { type: 'invoke_agent'; agentId: string; conversationId?: string; prompt?: string }
  | { type: 'call_webhook'; url: string; method?: 'POST' | 'PUT'; body?: unknown };
export interface Automation {
  id: string; name: string; description: string; enabled: boolean; triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>; conditions: Record<string, unknown>; actions: AutomationAction[];
  createdBy: string | null; createdAt: string; updatedAt: string; webhookEndpoint?: string;
}
export interface AutomationInput {
  name: string; description?: string; enabled?: boolean; triggerType: AutomationTriggerType;
  triggerConfig?: Record<string, unknown>; conditions?: Record<string, unknown>; actions: AutomationAction[];
}
export interface AutomationRun {
  id: string; automationId: string; triggerEventId: string | null; dedupeKey: string; status: 'running' | 'succeeded' | 'failed' | 'skipped';
  hopCount: number; input: Record<string, unknown>; output: Record<string, unknown>; error: string | null; createdAt: string; finishedAt: string | null;
}

export class AutomationsResource {
  constructor(private readonly http: HttpClient) {}
  list(): Promise<{ automations: Automation[] }> { return this.http.request('GET', '/api/v1/automations'); }
  create(input: AutomationInput): Promise<{ automation: Automation; webhookSecret?: string }> { return this.http.request('POST', '/api/v1/automations', input); }
  update(id: string, input: AutomationInput): Promise<Automation> { return this.http.request('PATCH', `/api/v1/automations/${encodeURIComponent(id)}`, input); }
  remove(id: string): Promise<void> { return this.http.request('DELETE', `/api/v1/automations/${encodeURIComponent(id)}`); }
  runs(automationId?: string): Promise<{ runs: AutomationRun[] }> {
    const query = automationId ? `?automationId=${encodeURIComponent(automationId)}` : '';
    return this.http.request('GET', `/api/v1/automations/runs${query}`);
  }
}
