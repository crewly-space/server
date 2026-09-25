import type { MentionRef, Message } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface SendMessageInput {
  body: string;
  mentions?: MentionRef[];
  replyToMessageId?: string | null;
  attachmentIds?: string[];
}

export class MessagesResource {
  constructor(private readonly http: HttpClient) {}

  send(
    conversationId: string,
    input: SendMessageInput
  ): Promise<Message> {
    return this.http.request('POST', `/api/v1/conversations/${encodePathSegment(conversationId)}/messages`, input);
  }

  list(conversationId: string, limit?: number): Promise<Message[]> {
    const query = limit !== undefined ? `?limit=${limit}` : '';
    return this.http.request('GET', `/api/v1/conversations/${encodePathSegment(conversationId)}/messages${query}`);
  }
}
