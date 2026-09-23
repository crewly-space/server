import type {
  Channel,
  ChannelCategory,
  ChannelList,
  ChannelPostRole,
  ChannelVisibility,
  ParticipantRef,
} from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface CreateChannelInput {
  name: string;
  topic?: string | null;
  visibility?: ChannelVisibility;
  postRole?: ChannelPostRole;
  categoryId?: string | null;
  members?: ParticipantRef[];
}

export interface UpdateChannelInput {
  name?: string;
  topic?: string | null;
  visibility?: ChannelVisibility;
  postRole?: ChannelPostRole;
  categoryId?: string | null;
  archived?: boolean;
}

/**
 * Channels are conversations: send and list their messages through
 * `messages`, with the channel's id as the conversation id.
 */
export class ChannelsResource {
  constructor(private readonly http: HttpClient) {}

  list(opts: { includeArchived?: boolean } = {}): Promise<ChannelList> {
    return this.http.request('GET', `/api/v1/channels${opts.includeArchived ? '?includeArchived=true' : ''}`);
  }

  get(id: string): Promise<Channel> {
    return this.http.request('GET', `/api/v1/channels/${encodePathSegment(id)}`);
  }

  create(input: CreateChannelInput): Promise<Channel> {
    return this.http.request('POST', '/api/v1/channels', input);
  }

  update(id: string, input: UpdateChannelInput): Promise<Channel> {
    return this.http.request('PATCH', `/api/v1/channels/${encodePathSegment(id)}`, input);
  }

  archive(id: string): Promise<Channel> {
    return this.update(id, { archived: true });
  }

  unarchive(id: string): Promise<Channel> {
    return this.update(id, { archived: false });
  }

  /** Puts these channels, in this order, into one category (null for none). */
  order(categoryId: string | null, channelIds: string[]): Promise<void> {
    return this.http.request('PUT', '/api/v1/channels/order', { categoryId, channelIds });
  }

  join(id: string): Promise<Channel> {
    return this.http.request('POST', `/api/v1/channels/${encodePathSegment(id)}/join`);
  }

  leave(id: string): Promise<void> {
    return this.http.request('POST', `/api/v1/channels/${encodePathSegment(id)}/leave`);
  }

  addMember(id: string, member: ParticipantRef): Promise<Channel> {
    return this.http.request('POST', `/api/v1/channels/${encodePathSegment(id)}/members`, member);
  }

  removeMember(id: string, member: ParticipantRef): Promise<Channel> {
    return this.http.request(
      'DELETE',
      `/api/v1/channels/${encodePathSegment(id)}/members/${member.participantType}/${encodePathSegment(member.participantId)}`
    );
  }

  blockAgent(id: string, agentId: string): Promise<Channel> {
    return this.http.request('PUT', `/api/v1/channels/${encodePathSegment(id)}/agents/${encodePathSegment(agentId)}/block`);
  }

  unblockAgent(id: string, agentId: string): Promise<Channel> {
    return this.http.request('DELETE', `/api/v1/channels/${encodePathSegment(id)}/agents/${encodePathSegment(agentId)}/block`);
  }

  createCategory(name: string): Promise<ChannelCategory> {
    return this.http.request('POST', '/api/v1/channel-categories', { name });
  }

  renameCategory(id: string, name: string): Promise<ChannelCategory> {
    return this.http.request('PATCH', `/api/v1/channel-categories/${encodePathSegment(id)}`, { name });
  }

  /** Its channels are kept and move to the uncategorised list. */
  deleteCategory(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/channel-categories/${encodePathSegment(id)}`);
  }

  orderCategories(categoryIds: string[]): Promise<void> {
    return this.http.request('PUT', '/api/v1/channel-categories/order', { categoryIds });
  }
}
