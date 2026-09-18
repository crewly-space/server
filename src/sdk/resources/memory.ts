import type { ConversationSummary, MemoryFact } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface CreateMemoryFactInput {
  content: string;
  source?: MemoryFact['source'];
  tags?: string[];
}

export interface UpdateMemoryFactInput {
  content?: string;
  tags?: string[];
}

export class MemoryResource {
  constructor(private readonly http: HttpClient) {}

  createFact(
    agentId: string,
    input: CreateMemoryFactInput
  ): Promise<MemoryFact> {
    return this.http.request('POST', `/api/v1/agents/${encodePathSegment(agentId)}/memory-facts`, input);
  }

  listFacts(agentId: string): Promise<MemoryFact[]> {
    return this.http.request('GET', `/api/v1/agents/${encodePathSegment(agentId)}/memory-facts`);
  }

  updateFact(agentId: string, factId: string, input: UpdateMemoryFactInput): Promise<MemoryFact> {
    return this.http.request(
      'PATCH',
      `/api/v1/agents/${encodePathSegment(agentId)}/memory-facts/${encodePathSegment(factId)}`,
      input
    );
  }

  deleteFact(agentId: string, factId: string): Promise<void> {
    return this.http.request(
      'DELETE',
      `/api/v1/agents/${encodePathSegment(agentId)}/memory-facts/${encodePathSegment(factId)}`
    );
  }

  getConversationSummary(conversationId: string): Promise<ConversationSummary> {
    return this.http.request('GET', `/api/v1/conversations/${encodePathSegment(conversationId)}/summary`);
  }
}
