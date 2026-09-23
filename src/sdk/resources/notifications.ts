import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export type NotificationType =
  | 'member.invited'
  | 'auth.magic_link'
  | 'mention.created'
  | 'dm.created'
  | 'agent.needs_attention'
  | 'agent.completed'
  | 'server.alert'
  | 'billing.warning';
export type NotificationChannel = 'in_app' | 'email';
export type NotificationMode = 'instant' | 'off';

/** One entry in a person's notification feed. Arrives live as the `notification.created` event on `user:<id>`. */
export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  /** A link back into Crewly, when the server knows its public address. */
  url: string | null;
  conversationId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPreference {
  type: NotificationType;
  label: string;
  /** Security and account events: always sent, not changeable. */
  mandatory: boolean;
  /** Only the channels this event uses appear. */
  channels: Partial<Record<NotificationChannel, NotificationMode>>;
}

export interface NotificationDelivery {
  id: string;
  eventType: NotificationType;
  recipient: string;
  channel: NotificationChannel;
  status: 'pending' | 'delivered' | 'failed' | 'skipped';
  reason: string | null;
  attempts: number;
  lastError: string | null;
  mailDeliveryId: string | null;
  createdAt: string;
}

/** The signed-in person's notifications and what they want to be told about. */
export class NotificationsResource {
  constructor(private readonly http: HttpClient) {}

  list(options: { unreadOnly?: boolean; limit?: number } = {}): Promise<{ notifications: Notification[]; unread: number }> {
    const query = new URLSearchParams();
    if (options.unreadOnly) query.set('unread', 'true');
    if (options.limit) query.set('limit', String(options.limit));
    return this.http.request('GET', `/api/v1/notifications${query.size ? `?${query}` : ''}`);
  }

  markRead(id: string): Promise<void> {
    return this.http.request('POST', `/api/v1/notifications/${encodePathSegment(id)}/read`);
  }

  markAllRead(): Promise<{ marked: number }> {
    return this.http.request('POST', '/api/v1/notifications/read-all');
  }

  preferences(): Promise<{ preferences: NotificationPreference[] }> {
    return this.http.request('GET', '/api/v1/notifications/preferences');
  }

  /** Mandatory events and channels an event does not use are refused. */
  setPreference(type: NotificationType, channel: NotificationChannel, mode: NotificationMode): Promise<{ preferences: NotificationPreference[] }> {
    return this.http.request('PUT', '/api/v1/notifications/preferences', { type, channel, mode });
  }

  /** Owners and admins: how deliveries went, including failures. */
  deliveries(filter: { status?: NotificationDelivery['status']; limit?: number } = {}): Promise<{ deliveries: NotificationDelivery[] }> {
    const query = new URLSearchParams();
    if (filter.status) query.set('status', filter.status);
    if (filter.limit) query.set('limit', String(filter.limit));
    return this.http.request('GET', `/api/v1/server/notifications/deliveries${query.size ? `?${query}` : ''}`);
  }
}
