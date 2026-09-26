import type { MentionRef, Message } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface SendMessageInput {
  body: string;
  mentions?: MentionRef[];
  replyToMessageId?: string | null;
  attachmentIds?: string[];
}

export interface MessageThread {
  rootMessageId: string;
  conversationId: string;
  status: 'open' | 'resolved' | 'archived';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  archivedAt: string | null;
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

  openThread(messageId: string): Promise<MessageThread> {
    return this.http.request('POST', `/api/v1/messages/${encodePathSegment(messageId)}/thread`);
  }
  thread(rootMessageId: string): Promise<{ thread: MessageThread; messages: Message[] }> {
    return this.http.request('GET', `/api/v1/threads/${encodePathSegment(rootMessageId)}/messages`);
  }
  sendThread(rootMessageId: string, input: SendMessageInput): Promise<Message> {
    return this.http.request('POST', `/api/v1/threads/${encodePathSegment(rootMessageId)}/messages`, input);
  }
  setThreadStatus(rootMessageId: string, status: MessageThread['status']): Promise<MessageThread> {
    return this.http.request('PATCH', `/api/v1/threads/${encodePathSegment(rootMessageId)}`, { status });
  }
  search(query: string, limit = 50): Promise<{ messages: Message[] }> {
    return this.http.request('GET', `/api/v1/messages/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  }
}
