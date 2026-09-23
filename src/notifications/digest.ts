import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret } from '../db/secrets.js';
import { MailDisabledError, type MailService } from '../mail/service.js';
import { getUserById } from '../users/repository.js';
import { DIGEST_QUEUED, type ChannelMessage, type NotificationService, type NotificationType } from './service.js';

/*
 * Scheduled digests: email a person chose to receive in one batch.
 *
 * Events in digest mode wait as queued email deliveries. At the person's next
 * scheduled time they are gathered, repeats about the same thing summarised
 * into one line, and sent as one email through the mail gateway -- whose retry
 * policy then applies to the digest like any other message.
 *
 * Preferences are read again when the digest goes out: an event whose email
 * the person has since turned off is dropped; one they have since made
 * instant still goes in this digest, since it was already waiting. Mandatory
 * and instant events never wait here in the first place.
 */

export interface DigestSchedule {
  frequency: 'daily' | 'weekly';
  /** 0-23, UTC. */
  hourUtc: number;
  /** Weekly only: 0 = Sunday. */
  weekday: number | null;
}

export const DEFAULT_DIGEST_SCHEDULE: DigestSchedule = { frequency: 'daily', hourUtc: 8, weekday: null };

export function digestSchedule(db: Database, userId: string): DigestSchedule {
  const row = db.prepare('SELECT frequency, hour_utc, weekday FROM notification_digest_settings WHERE user_id = ?').get(userId) as
    { frequency: DigestSchedule['frequency']; hour_utc: number; weekday: number | null } | undefined;
  return row ? { frequency: row.frequency, hourUtc: row.hour_utc, weekday: row.weekday } : DEFAULT_DIGEST_SCHEDULE;
}

export function setDigestSchedule(db: Database, userId: string, schedule: DigestSchedule): DigestSchedule {
  const weekday = schedule.frequency === 'weekly' ? schedule.weekday ?? 1 : null;
  db.prepare(
    `INSERT INTO notification_digest_settings (user_id, frequency, hour_utc, weekday, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET frequency = excluded.frequency, hour_utc = excluded.hour_utc,
       weekday = excluded.weekday, updated_at = excluded.updated_at`,
  ).run(userId, schedule.frequency, schedule.hourUtc, weekday, new Date().toISOString());
  return digestSchedule(db, userId);
}

/** The most recent scheduled time at or before `now`. */
export function lastScheduledAt(schedule: DigestSchedule, now: Date): Date {
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), schedule.hourUtc));
  if (schedule.frequency === 'daily') {
    if (slot > now) slot.setUTCDate(slot.getUTCDate() - 1);
    return slot;
  }
  const back = (slot.getUTCDay() - (schedule.weekday ?? 1) + 7) % 7;
  slot.setUTCDate(slot.getUTCDate() - back);
  if (slot > now) slot.setUTCDate(slot.getUTCDate() - 7);
  return slot;
}

interface QueuedRow {
  id: string;
  event_type: NotificationType;
  collapse_key: string | null;
  payload_ciphertext: string | null;
  created_at: string;
}

/** One line of a digest: an event, or several equivalent ones summarised. */
export interface DigestLine {
  type: NotificationType;
  title: string;
  body: string;
  url: string | null;
  count: number;
}

export function summarise(messages: Array<ChannelMessage & { collapseKey: string | null }>): DigestLine[] {
  const lines = new Map<string, DigestLine>();
  for (const message of messages) {
    // Repeats of one kind about one thing are one line; the newest says what it is.
    const key = message.collapseKey ? `${message.type}\u0000${message.collapseKey}` : message.deliveryId;
    const existing = lines.get(key);
    if (existing) {
      existing.count += 1;
      existing.title = message.title;
      existing.body = message.body;
    } else {
      lines.set(key, { type: message.type, title: message.title, body: message.body, url: message.url, count: 1 });
    }
  }
  return [...lines.values()];
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);

const clip = (value: string, length: number) => (value.length > length ? `${value.slice(0, length - 1)}…` : value);

export function renderDigest(lines: DigestLine[]): { subject: string; text: string; html: string } {
  const total = lines.reduce((sum, line) => sum + line.count, 0);
  const subject = `Your Crewly digest: ${total} update${total === 1 ? '' : 's'}`;
  const heading = (line: DigestLine) => `${line.title}${line.count > 1 ? ` (and ${line.count - 1} more like it)` : ''}`;
  const text = [
    subject,
    '',
    ...lines.flatMap((line) => [`• ${heading(line)}`, `  ${clip(line.body, 200)}`, ...(line.url ? [`  ${line.url}`] : []), '']),
    'Change what you get in Crewly: Inbox → Notification settings.',
  ].join('\n');
  const items = lines.map((line) => `<li><strong>${escapeHtml(heading(line))}</strong><br>${escapeHtml(clip(line.body, 200))}${
    line.url ? `<br><a href="${escapeHtml(line.url)}">Open in Crewly</a>` : ''}</li>`).join('');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5"><p>${escapeHtml(subject)}</p><ul>${items}</ul><p>Change what you get in Crewly: Inbox → Notification settings.</p></body></html>`;
  return { subject, text, html };
}

/**
 * Sends every digest whose time has come. Safe to call as often as a timer
 * likes: each person's slot is sent at most once.
 */
export async function sendDueDigests(db: Database, service: NotificationService, mail: MailService, now = new Date()): Promise<number> {
  const people = db.prepare(
    "SELECT DISTINCT recipient FROM notification_deliveries WHERE channel = 'email' AND status = 'pending' AND reason = ?",
  ).pluck().all(DIGEST_QUEUED) as string[];
  let sent = 0;
  for (const userId of people) {
    const user = getUserById(db, userId);
    const periodEnd = lastScheduledAt(digestSchedule(db, userId), now).toISOString();
    if (db.prepare('SELECT 1 FROM notification_digests WHERE user_id = ? AND period_end = ?').get(userId, periodEnd)) continue;
    // Only what was waiting when the slot came round; later events wait for the next one.
    const queued = db.prepare(
      `SELECT id, event_type, collapse_key, payload_ciphertext, created_at FROM notification_deliveries
       WHERE recipient = ? AND channel = 'email' AND status = 'pending' AND reason = ? AND created_at <= ?
       ORDER BY created_at`,
    ).all(userId, DIGEST_QUEUED, periodEnd) as QueuedRow[];
    if (queued.length === 0) continue;

    const settle = db.prepare('UPDATE notification_deliveries SET status = ?, reason = ?, mail_delivery_id = ?, last_error = ?, payload_ciphertext = NULL, updated_at = ? WHERE id = ?');
    const stamp = new Date().toISOString();
    const keep: QueuedRow[] = [];
    for (const row of queued) {
      if (!user || user.suspended_at || service.mode(userId, row.event_type, 'email') === 'off') {
        settle.run('skipped', user && !user.suspended_at ? 'preference_changed' : 'no_account', null, null, stamp, row.id);
      } else {
        keep.push(row);
      }
    }
    if (keep.length === 0 || !user) continue;

    const messages = keep.map((row) => ({
      ...(JSON.parse(decryptDatabaseSecret(db, row.payload_ciphertext!)) as ChannelMessage),
      collapseKey: row.collapse_key,
    }));
    const digestId = randomUUID();
    let delivery;
    try {
      delivery = await mail.send({ to: user.email, content: renderDigest(summarise(messages)), idempotencyKey: `digest:${userId}:${periodEnd}` });
    } catch (error) {
      if (!(error instanceof MailDisabledError)) throw error;
      for (const row of keep) settle.run('skipped', 'mail_disabled', null, null, stamp, row.id);
      continue;
    }
    db.transaction(() => {
      db.prepare('INSERT INTO notification_digests (id, user_id, period_end, item_count, mail_delivery_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(digestId, userId, periodEnd, keep.length, delivery.id, stamp);
      // Each event takes the digest's fate; one still retrying is settled later from the mail delivery.
      const status = delivery.status === 'sent' ? 'delivered' : delivery.status === 'failed' ? 'failed' : 'pending';
      for (const row of keep) settle.run(status, `digest:${digestId}`, delivery.id, delivery.lastError, stamp, row.id);
    })();
    sent += 1;
  }
  return sent;
}
