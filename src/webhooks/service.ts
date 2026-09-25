import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { createMessage } from '../messages/repository.js';
import type { Message } from '../protocol/index.js';

export const WEBHOOK_MAX_BODY_BYTES = 32 * 1024;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
const recentRequests = new Map<string, number[]>();

export interface WebhookView { id: string; channelId: string; name: string; createdAt: string; updatedAt: string; lastUsedAt: string | null; revokedAt: string | null; }
export interface CreatedWebhook { webhook: WebhookView; secret: string; endpoint: string; }
interface WebhookRow { id: string; channel_id: string; name: string; token_hash: string; created_by: string; created_at: string; updated_at: string; last_used_at: string | null; revoked_at: string | null; }

const hash = (secret: string): string => createHash('sha256').update(secret).digest('hex');
const view = (row: WebhookRow): WebhookView => ({ id: row.id, channelId: row.channel_id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at });
const row = (db: Database, id: string): WebhookRow | undefined => db.prepare('SELECT * FROM incoming_webhooks WHERE id = ?').get(id) as WebhookRow | undefined;

export function createWebhook(db: Database, input: { channelId: string; name: string; createdBy: string; endpointBase: string }): CreatedWebhook {
  const id = randomUUID(); const secret = randomBytes(32).toString('base64url'); const now = new Date().toISOString();
  db.prepare(`INSERT INTO incoming_webhooks (id, channel_id, name, token_hash, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.channelId, input.name, hash(secret), input.createdBy, now, now);
  const webhook = view(row(db, id)!);
  return { webhook, secret, endpoint: `${input.endpointBase.replace(/\/$/, '')}/api/v1/webhooks/${id}/${secret}` };
}
export function listWebhooks(db: Database, channelId?: string): WebhookView[] {
  const sql = channelId ? 'SELECT * FROM incoming_webhooks WHERE channel_id = ? ORDER BY created_at DESC' : 'SELECT * FROM incoming_webhooks ORDER BY created_at DESC';
  return (db.prepare(sql).all(...(channelId ? [channelId] : [])) as WebhookRow[]).map(view);
}
export function rotateWebhook(db: Database, id: string, endpointBase: string): CreatedWebhook | undefined {
  const current = row(db, id); if (!current || current.revoked_at) return undefined;
  const secret = randomBytes(32).toString('base64url'); const now = new Date().toISOString();
  db.prepare('UPDATE incoming_webhooks SET token_hash = ?, updated_at = ? WHERE id = ?').run(hash(secret), now, id);
  return { webhook: view(row(db, id)!), secret, endpoint: `${endpointBase.replace(/\/$/, '')}/api/v1/webhooks/${id}/${secret}` };
}
export function revokeWebhook(db: Database, id: string): WebhookView | undefined {
  const current = row(db, id); if (!current) return undefined;
  const now = new Date().toISOString(); db.prepare('UPDATE incoming_webhooks SET revoked_at = ?, updated_at = ? WHERE id = ?').run(now, now, id); return view(row(db, id)!);
}

function allowed(hashValue: string): boolean {
  const now = Date.now(); const recent = (recentRequests.get(hashValue) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) { recentRequests.set(hashValue, recent); return false; }
  recent.push(now); recentRequests.set(hashValue, recent); return true;
}

function messageBody(payload: Record<string, unknown>): string {
  const title = typeof payload.title === 'string' ? payload.title : typeof payload.event === 'string' ? payload.event : undefined;
  const body = typeof payload.body === 'string' ? payload.body : typeof payload.message === 'string' ? payload.message : typeof payload.text === 'string' ? payload.text : typeof payload.description === 'string' ? payload.description : undefined;
  const fields = [typeof payload.severity === 'string' ? `Severity: ${payload.severity}` : null, typeof payload.status === 'string' ? `Status: ${payload.status}` : null, typeof payload.source_url === 'string' ? `Source: ${payload.source_url}` : typeof payload.url === 'string' ? `Source: ${payload.url}` : null, typeof payload.timestamp === 'string' ? `Time: ${payload.timestamp}` : null].filter(Boolean);
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? `\nMetadata: ${JSON.stringify(payload.metadata)}` : '';
  const fallback = JSON.stringify(payload, null, 2);
  return [title ? `**${title}**` : null, body ?? fallback, ...fields, metadata].filter(Boolean).join('\n').slice(0, 20_000);
}

export function deliverWebhook(db: Database, input: { id: string; secret: string; payload: Record<string, unknown>; externalEventId?: string }): { message: Message; duplicate: boolean } {
  const current = row(db, input.id);
  if (!current || current.revoked_at) throw new Error('webhook_not_found');
  const provided = Buffer.from(hash(input.secret)); const stored = Buffer.from(current.token_hash);
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) throw new Error('webhook_not_found');
  if (!allowed(current.token_hash)) throw new Error('webhook_rate_limited');
  if (input.externalEventId) {
    const previous = db.prepare('SELECT message_id FROM incoming_webhook_events WHERE webhook_id = ? AND external_event_id = ?').get(input.id, input.externalEventId) as { message_id: string | null } | undefined;
    if (previous?.message_id) {
      const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(previous.message_id) as { id: string; conversation_id: string; author_id: string; author_type: 'integration'; body: string; reply_to_message_id: string | null; created_at: string };
      return { duplicate: true, message: { id: existing.id, conversationId: existing.conversation_id, authorId: existing.author_id, authorType: existing.author_type, body: existing.body, mentions: [], replyToMessageId: existing.reply_to_message_id, attachments: [], createdAt: existing.created_at } };
    }
  }
  const message = createMessage(db, { conversationId: current.channel_id, authorId: `webhook:${current.id}`, authorType: 'integration', body: messageBody(input.payload), mentions: [], replyToMessageId: null });
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE incoming_webhooks SET last_used_at = ?, updated_at = ? WHERE id = ?').run(now, now, input.id);
    if (input.externalEventId) db.prepare('INSERT OR IGNORE INTO incoming_webhook_events (webhook_id, external_event_id, message_id, created_at) VALUES (?, ?, ?, ?)').run(input.id, input.externalEventId, message.id, now);
  })();
  return { message, duplicate: false };
}
