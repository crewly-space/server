import type { Agent, ModelPolicy } from '../../protocol/index.js';
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
}
