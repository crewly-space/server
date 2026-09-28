import type { Conversation, ConversationReplySettings, ParticipantRef } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface CreateDmInput {
  participantId: string;
  participantType?: ParticipantRef['participantType'];
}

export interface CreateGroupInput {
  name: string;
  participants: ParticipantRef[];
}

export type AddConversationMemberInput = ParticipantRef;

export class ConversationsResource {
  constructor(private readonly http: HttpClient) {}

  createDm(input: CreateDmInput): Promise<Conversation> {
    return this.http.request('POST', '/api/v1/conversations', input);
  }

  createGroup(input: CreateGroupInput): Promise<Conversation> {
    return this.http.request('POST', '/api/v1/conversations/group', input);
  }

  list(): Promise<Conversation[]> {
    return this.http.request('GET', '/api/v1/conversations');
  }

  /** Who answers a message nobody addressed: mentions & keywords, a model, or every agent. */
  replyMode(conversationId: string): Promise<ConversationReplySettings> {
    return this.http.request('GET', `/api/v1/conversations/${encodePathSegment(conversationId)}/reply-mode`);
  }

  setReplyMode(conversationId: string, input: ConversationReplySettings): Promise<ConversationReplySettings> {
    return this.http.request('PUT', `/api/v1/conversations/${encodePathSegment(conversationId)}/reply-mode`, input);
  }

  addMember(conversationId: string, input: AddConversationMemberInput): Promise<void> {
    return this.http.request('POST', `/api/v1/conversations/${encodePathSegment(conversationId)}/members`, input);
  }

  removeMember(conversationId: string, participantId: string): Promise<void> {
    return this.http.request(
      'DELETE',
      `/api/v1/conversations/${encodePathSegment(conversationId)}/members/${encodePathSegment(participantId)}`
    );
  }
}
