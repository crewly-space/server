import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret, encryptDatabaseSecret } from '../db/secrets.js';
import { replyAddress } from '../mail/inbound.js';
import { MailDisabledError, type MailService } from '../mail/service.js';
import { getUserById } from '../users/repository.js';
import type { ConnectionHub } from '../ws/hub.js';

/*
 * One pipeline for everything a person is told about.
 *
 * Feature code emits a normalised event -- what happened, to whom, and a key
 * that makes it the same event if it is emitted again -- and never sends mail
 * or writes a notification itself. The pipeline decides per recipient and
 * channel from one policy (mandatory events, then the person's preference,
 * then the default), so in-app and email always agree, and delivers through
 * channels that can be added to without touching any emitter.
 */

export type NotificationChannelId = 'in_app' | 'email';
export type NotificationMode = 'instant' | 'off';

interface EventPolicy {
  /** Security and account mail: cannot be switched off. */
  mandatory: boolean;
  /** Channels this event can use, with the mode a person gets until they choose. */
  defaults: Partial<Record<NotificationChannelId, NotificationMode>>;
  label: string;
}

export const NOTIFICATION_EVENTS = {
  'member.invited': { mandatory: true, defaults: { email: 'instant' }, label: 'Invitations' },
  'auth.magic_link': { mandatory: true, defaults: { email: 'instant' }, label: 'Sign-in links' },
  'mention.created': { mandatory: false, defaults: { in_app: 'instant', email: 'instant' }, label: 'Mentions' },
  'dm.created': { mandatory: false, defaults: { in_app: 'instant', email: 'off' }, label: 'Direct messages' },
  'agent.needs_attention': { mandatory: false, defaults: { in_app: 'instant', email: 'instant' }, label: 'Agents that need you' },
  'agent.completed': { mandatory: false, defaults: { in_app: 'instant', email: 'off' }, label: 'Agent work finished' },
  'server.alert': { mandatory: false, defaults: { in_app: 'instant', email: 'instant' }, label: 'Server alerts' },
  'billing.warning': { mandatory: false, defaults: { in_app: 'instant', email: 'instant' }, label: 'Spend warnings' },
} as const satisfies Record<string, EventPolicy>;

export type NotificationType = keyof typeof NOTIFICATION_EVENTS;
export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_EVENTS) as NotificationType[];

/** Equivalent events for one person and channel inside this window become one. */
export const BURST_WINDOW_MS = 60_000;
/** In-app delivery is local; it gets a few quick retries. Email follows the mail gateway's own policy. */
const IN_APP_MAX_ATTEMPTS = 3;

export type NotificationRecipient = { userId: string } | { email: string };

export interface NotificationEvent {
  type: NotificationType;
  recipients: NotificationRecipient[];
  /** The same key means the same event: emitting it again notifies nobody twice. */
  dedupeKey: string;
  /** Events sharing this key for one person collapse within the burst window, e.g. a conversation. */
  collapseKey?: string;
  title: string;
  body: string;
  conversationId?: string;
  /** Mail with a template of its own (invites, sign-in links) instead of the generic notification. */
  template?: { id: 'member.invited' | 'auth.magic_link'; variables: Record<string, string> };
}

export interface InAppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  url: string | null;
  conversationId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationDelivery {
  id: string;
  eventType: NotificationType;
  recipient: string;
  channel: NotificationChannelId;
  status: 'pending' | 'delivered' | 'failed' | 'skipped';
  reason: string | null;
  attempts: number;
  lastError: string | null;
  mailDeliveryId: string | null;
  createdAt: string;
}

export interface PreferenceView {
  type: NotificationType;
  label: string;
  mandatory: boolean;
  channels: Partial<Record<NotificationChannelId, NotificationMode>>;
}

export class NotificationPolicyError extends Error {}

interface DeliveryRow {
  id: string;
  event_type: NotificationType;
  dedupe_key: string;
  recipient: string;
  channel: NotificationChannelId;
  collapse_key: string | null;
  status: NotificationDelivery['status'];
  reason: string | null;
  attempts: number;
  last_error: string | null;
  mail_delivery_id: string | null;
  payload_ciphertext: string | null;
  next_attempt_at: string | null;
  created_at: string;
}

const toDelivery = (row: DeliveryRow): NotificationDelivery => ({
  id: row.id,
  eventType: row.event_type,
  recipient: row.recipient,
  channel: row.channel,
  status: row.status,
  reason: row.reason,
  attempts: row.attempts,
  lastError: row.last_error,
  mailDeliveryId: row.mail_delivery_id,
  createdAt: row.created_at,
});

/** What a channel is handed: the event as it applies to one recipient. */
export interface ChannelMessage {
  deliveryId: string;
  type: NotificationType;
  userId: string | null;
  email: string | null;
  title: string;
  body: string;
  url: string | null;
  conversationId: string | null;
  template?: NotificationEvent['template'];
}

export type ChannelResult =
  | { status: 'delivered'; mailDeliveryId?: string }
  /** Handed on to something that retries by itself (the mail gateway). */
  | { status: 'pending'; mailDeliveryId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string; retryable: boolean; mailDeliveryId?: string };

/** A way to reach a person. New ones (push, webhooks) plug in here; emitters do not change. */
export interface NotificationChannel {
  id: NotificationChannelId;
  deliver(message: ChannelMessage): Promise<ChannelResult>;
}

export function inAppChannel(db: Database, hub: ConnectionHub): NotificationChannel {
  return {
    id: 'in_app',
    async deliver(message) {
      if (!message.userId) return { status: 'skipped', reason: 'no_account' };
      const notification: InAppNotification = {
        id: message.deliveryId,
        type: message.type,
        title: message.title,
        body: message.body,
        url: message.url,
        conversationId: message.conversationId,
        createdAt: new Date().toISOString(),
        readAt: null,
      };
      db.prepare(
        `INSERT OR IGNORE INTO notifications (id, user_id, type, title, body, url, conversation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(notification.id, message.userId, notification.type, notification.title, notification.body, notification.url, notification.conversationId, notification.createdAt);
      hub.publish(`user:${message.userId}`, 'notification.created', { ...notification });
      return { status: 'delivered' };
    },
  };
}

export function emailChannel(db: Database, mail: MailService, fetchImpl: typeof fetch): NotificationChannel {
  return {
    id: 'email',
    async deliver(message) {
      const to = message.email ?? (message.userId ? getUserById(db, message.userId)?.email : undefined);
      if (!to) return { status: 'skipped', reason: 'no_address' };
      // Replying continues the conversation when this server receives mail.
      const replyTo = message.conversationId && message.userId
        ? await replyAddress(db, fetchImpl, message.conversationId, message.userId)
        : undefined;
      try {
        const delivery = await mail.send({
          to,
          template: message.template ?? {
            id: 'notification',
            variables: { title: message.title, body: message.body, ...(message.url ? { url: message.url } : {}) },
          },
          idempotencyKey: `notification:${message.deliveryId}`,
          ...(replyTo ? { headers: { 'Reply-To': replyTo } } : {}),
        });
        if (delivery.status === 'sent') return { status: 'delivered', mailDeliveryId: delivery.id };
        if (delivery.status === 'failed') {
          return { status: 'failed', error: delivery.lastError ?? 'mail failed', retryable: false, mailDeliveryId: delivery.id };
        }
        return { status: 'pending', mailDeliveryId: delivery.id };
      } catch (error) {
        if (error instanceof MailDisabledError) return { status: 'skipped', reason: 'mail_disabled' };
        throw error;
      }
    },
  };
}

export class NotificationService {
  private readonly channels: Map<NotificationChannelId, NotificationChannel>;

  constructor(
    private readonly db: Database,
    channels: NotificationChannel[],
    private readonly options: { publicUrl?: string } = {},
  ) {
    this.channels = new Map(channels.map((channel) => [channel.id, channel]));
  }

  /** Mandatory first, then the person's choice, then the default. The same inputs always give the same answer. */
  mode(userId: string | null, type: NotificationType, channel: NotificationChannelId): NotificationMode | undefined {
    const policy: EventPolicy = NOTIFICATION_EVENTS[type];
    const fallback = policy.defaults[channel];
    if (!fallback) return undefined;
    if (policy.mandatory || !userId) return 'instant';
    const chosen = this.db.prepare('SELECT mode FROM notification_preferences WHERE user_id = ? AND event_type = ? AND channel = ?')
      .pluck().get(userId, type, channel) as NotificationMode | undefined;
    return chosen ?? fallback;
  }

  preferences(userId: string): PreferenceView[] {
    return NOTIFICATION_TYPES.map((type) => {
      const policy: EventPolicy = NOTIFICATION_EVENTS[type];
      return {
        type,
        label: policy.label,
        mandatory: policy.mandatory,
        channels: Object.fromEntries((Object.keys(policy.defaults) as NotificationChannelId[]).map((channel) => [channel, this.mode(userId, type, channel)!])),
      };
    });
  }

  setPreference(userId: string, type: NotificationType, channel: NotificationChannelId, mode: NotificationMode): void {
    const policy: EventPolicy = NOTIFICATION_EVENTS[type];
    if (policy.mandatory) throw new NotificationPolicyError(`${policy.label} cannot be turned off`);
    if (!policy.defaults[channel]) throw new NotificationPolicyError(`${policy.label} are not sent by ${channel === 'email' ? 'email' : 'in-app'}`);
    this.db.prepare(
      `INSERT INTO notification_preferences (user_id, event_type, channel, mode, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, event_type, channel) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
    ).run(userId, type, channel, mode, new Date().toISOString());
  }

  private url(conversationId: string | undefined): string | null {
    if (!conversationId || !this.options.publicUrl) return null;
    return `${this.options.publicUrl}/?conversation=${encodeURIComponent(conversationId)}`;
  }

  /**
   * Decides and delivers an event. Resolves once every recipient and channel
   * has been tried; failures are recorded on the delivery, never thrown.
   */
  async emit(event: NotificationEvent): Promise<NotificationDelivery[]> {
    const results: NotificationDelivery[] = [];
    const now = new Date();
    for (const recipient of event.recipients) {
      const userId = 'userId' in recipient ? recipient.userId : null;
      if (userId) {
        const user = getUserById(this.db, userId);
        if (!user || user.suspended_at) continue;
      }
      const recipientKey = userId ?? `email:${(recipient as { email: string }).email.toLowerCase()}`;
      for (const channelId of ['in_app', 'email'] as const) {
        if (!userId && channelId === 'in_app') continue;
        const mode = this.mode(userId, event.type, channelId);
        if (mode !== 'instant') continue;
        const payload: ChannelMessage = {
          deliveryId: randomUUID(),
          type: event.type,
          userId,
          email: userId ? null : (recipient as { email: string }).email,
          title: event.title,
          body: event.body,
          url: this.url(event.conversationId),
          conversationId: event.conversationId ?? null,
          template: event.template,
        };
        const collapsed = event.collapseKey !== undefined && this.db.prepare(
          `SELECT 1 FROM notification_deliveries
           WHERE recipient = ? AND channel = ? AND event_type = ? AND collapse_key = ? AND created_at > ? AND status <> 'failed'`,
        ).get(recipientKey, channelId, event.type, event.collapseKey, new Date(now.getTime() - BURST_WINDOW_MS).toISOString());
        const inserted = this.db.prepare(
          `INSERT OR IGNORE INTO notification_deliveries
             (id, event_type, dedupe_key, recipient, channel, collapse_key, status, reason, payload_ciphertext, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          payload.deliveryId, event.type, event.dedupeKey, recipientKey, channelId, event.collapseKey ?? null,
          collapsed ? 'skipped' : 'pending', collapsed ? 'collapsed' : null,
          collapsed ? null : encryptDatabaseSecret(this.db, JSON.stringify(payload)), now.toISOString(), now.toISOString(),
        );
        // Emitted before: the delivery that already exists is the answer.
        if (inserted.changes === 0 || collapsed) {
          const existing = this.db.prepare('SELECT * FROM notification_deliveries WHERE dedupe_key = ? AND recipient = ? AND channel = ?')
            .get(event.dedupeKey, recipientKey, channelId) as DeliveryRow;
          results.push(toDelivery(existing));
          continue;
        }
        results.push(await this.attempt(payload.deliveryId));
      }
    }
    return results;
  }

  private async attempt(id: string): Promise<NotificationDelivery> {
    const row = this.db.prepare('SELECT * FROM notification_deliveries WHERE id = ?').get(id) as DeliveryRow;
    if (!row.payload_ciphertext) return toDelivery(row);
    const message = JSON.parse(decryptDatabaseSecret(this.db, row.payload_ciphertext)) as ChannelMessage;
    const channel = this.channels.get(row.channel);
    let result: ChannelResult;
    try {
      result = channel ? await channel.deliver(message) : { status: 'skipped', reason: 'channel_unavailable' };
    } catch (error) {
      result = { status: 'failed', error: error instanceof Error ? error.message : 'delivery failed', retryable: true };
    }
    const attempts = row.attempts + 1;
    const now = new Date();
    // Email retries belong to the mail gateway; only local channels are retried from here.
    const retry = result.status === 'failed' && result.retryable && row.channel === 'in_app' && attempts < IN_APP_MAX_ATTEMPTS;
    const finished = result.status === 'delivered' || result.status === 'skipped' || (result.status === 'failed' && !retry);
    this.db.prepare(
      `UPDATE notification_deliveries SET status = ?, reason = ?, attempts = ?, last_error = ?, mail_delivery_id = COALESCE(?, mail_delivery_id),
         next_attempt_at = ?, payload_ciphertext = ?, updated_at = ? WHERE id = ?`,
    ).run(
      result.status === 'failed' && retry ? 'pending' : result.status,
      result.status === 'skipped' ? result.reason : null,
      attempts,
      result.status === 'failed' ? result.error.slice(0, 500) : null,
      'mailDeliveryId' in result ? result.mailDeliveryId ?? null : null,
      retry ? new Date(now.getTime() + 30_000 * attempts).toISOString() : null,
      finished || result.status === 'pending' ? null : row.payload_ciphertext,
      now.toISOString(),
      id,
    );
    return toDelivery(this.db.prepare('SELECT * FROM notification_deliveries WHERE id = ?').get(id) as DeliveryRow);
  }

  /**
   * Retries local deliveries that failed, and settles email deliveries from
   * what the mail gateway has since done with them. Called on a timer.
   */
  async retryDue(now = new Date()): Promise<number> {
    const due = this.db.prepare(
      "SELECT id FROM notification_deliveries WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? LIMIT 100",
    ).pluck().all(now.toISOString()) as string[];
    for (const id of due) await this.attempt(id);
    this.db.prepare(
      `UPDATE notification_deliveries
       SET status = CASE (SELECT status FROM mail_deliveries WHERE id = mail_delivery_id) WHEN 'sent' THEN 'delivered' ELSE 'failed' END,
           last_error = (SELECT last_error FROM mail_deliveries WHERE id = mail_delivery_id),
           updated_at = ?
       WHERE status = 'pending' AND mail_delivery_id IS NOT NULL
         AND (SELECT status FROM mail_deliveries WHERE id = mail_delivery_id) IN ('sent', 'failed')`,
    ).run(now.toISOString());
    return due.length;
  }

  listForUser(userId: string, filter: { unreadOnly: boolean; limit: number }): InAppNotification[] {
    const rows = this.db.prepare(
      `SELECT * FROM notifications WHERE user_id = ? ${filter.unreadOnly ? 'AND read_at IS NULL' : ''}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(userId, filter.limit) as Array<{ id: string; type: NotificationType; title: string; body: string; url: string | null; conversation_id: string | null; created_at: string; read_at: string | null }>;
    return rows.map((row) => ({
      id: row.id, type: row.type, title: row.title, body: row.body, url: row.url,
      conversationId: row.conversation_id, createdAt: row.created_at, readAt: row.read_at,
    }));
  }

  unreadCount(userId: string): number {
    return this.db.prepare('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL').pluck().get(userId) as number;
  }

  markRead(userId: string, id?: string): number {
    const now = new Date().toISOString();
    return id
      ? Number(this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(now, id, userId).changes)
      : Number(this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, userId).changes);
  }

  listDeliveries(filter: { status?: NotificationDelivery['status']; limit: number }): NotificationDelivery[] {
    const rows = (filter.status
      ? this.db.prepare('SELECT * FROM notification_deliveries WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(filter.status, filter.limit)
      : this.db.prepare('SELECT * FROM notification_deliveries ORDER BY created_at DESC, rowid DESC LIMIT ?').all(filter.limit)) as DeliveryRow[];
    return rows.map(toDelivery);
  }
}

/*
 * Feature code reaches the pipeline through the database it already holds,
 * the way it reaches the secret key: buildApp registers the service for its
 * database, and code running without one (a repository test) emits nothing.
 */
const services = new WeakMap<Database, NotificationService>();

export function registerNotificationService(db: Database, service: NotificationService): void {
  services.set(db, service);
}

export function notificationServiceFor(db: Database): NotificationService | undefined {
  return services.get(db);
}

/** Emits an event through the registered pipeline. Never throws: a notification must not break what caused it. */
export async function emitNotification(db: Database, event: NotificationEvent): Promise<NotificationDelivery[]> {
  const service = services.get(db);
  if (!service || event.recipients.length === 0) return [];
  try {
    return await service.emit(event);
  } catch {
    return [];
  }
}

/** The people in a conversation, for events about it. */
export function conversationPeople(db: Database, conversationId: string): NotificationRecipient[] {
  return (db.prepare("SELECT participant_id FROM conversation_participants WHERE conversation_id = ? AND participant_type = 'user'")
    .pluck().all(conversationId) as string[]).map((userId) => ({ userId }));
}

/** Everyone who administers the server, for server-wide events. */
export function administrators(db: Database): NotificationRecipient[] {
  return (db.prepare("SELECT id FROM users WHERE role IN ('owner', 'admin') AND suspended_at IS NULL").pluck().all() as string[])
    .map((userId) => ({ userId }));
}
