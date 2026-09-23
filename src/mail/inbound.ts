import { randomInt } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { crewlyServiceRequest } from '../crewly/connection.js';
import { getConversation, isParticipant } from '../conversations/repository.js';
import { enqueueJob } from '../jobs/repository.js';
import { SUMMARIZE_CONVERSATION_JOB_TYPE } from '../memory/summary.js';
import { createMessage } from '../messages/repository.js';
import { getUserById } from '../users/repository.js';
import type { ConnectionHub } from '../ws/hub.js';

/*
 * Email coming back into Crewly, through Crewly Mail (`mail:receive`).
 *
 * A reply to a notification lands in the conversation it was about, posted
 * as the person it was sent to -- and only when it came from their address.
 * Mail to a routed address (support@…) is posted into its channel by the
 * admin who set the route up, quoting who wrote it. Crewly holds the mail
 * until this server pulls it, so a server behind NAT still receives.
 */

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface InboundMessage {
  id: string;
  kind: 'reply' | 'route';
  target: string;
  recipient: string;
  from: { email: string; name: string | null };
  subject: string;
  text: string;
  html: string | null;
  headers: Record<string, string>;
  attachments: Array<{ name: string; contentType: string; size: number }>;
  authenticated: boolean | null;
  receivedAt: string;
}

export interface InboundRecord {
  id: string;
  kind: 'reply' | 'route';
  sender: string;
  recipient: string;
  status: 'delivered' | 'rejected';
  reason: string | null;
  conversationId: string | null;
  messageId: string | null;
  receivedAt: string;
  processedAt: string;
}

/** The inbound domain and this server's key, asked of Crewly once and kept. */
async function inboundAddress(db: Database, fetchImpl: typeof fetch): Promise<{ domain: string; key: string }> {
  const known = db.prepare('SELECT inbound_domain AS domain, inbound_key AS key FROM crewly_connection WHERE id = 1').get() as { domain: string | null; key: string | null } | undefined;
  if (known?.domain && known.key) return { domain: known.domain, key: known.key };
  const answer = await crewlyServiceRequest(db, fetchImpl, 'mail:receive', 'GET', '/api/v1/instance/mail/inbound/address');
  if (answer.status !== 200) throw new Error(String(answer.body.error ?? 'Crewly did not give an inbound address'));
  const domain = String(answer.body.domain);
  const key = String(answer.body.key);
  db.prepare('UPDATE crewly_connection SET inbound_domain = ?, inbound_key = ? WHERE id = 1').run(domain, key);
  return { domain, key };
}

/**
 * The address a person can reply to, to post in a conversation. Undefined
 * when this server does not receive mail, so the caller simply sends without
 * a Reply-To.
 */
export async function replyAddress(db: Database, fetchImpl: typeof fetch, conversationId: string, userId: string): Promise<string | undefined> {
  let address: { domain: string; key: string };
  try {
    address = await inboundAddress(db, fetchImpl);
  } catch {
    return undefined;
  }
  let token = db.prepare('SELECT token FROM mail_reply_tokens WHERE conversation_id = ? AND user_id = ?').pluck().get(conversationId, userId) as string | undefined;
  if (!token) {
    token = Array.from({ length: 16 }, () => TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)]).join('');
    db.prepare('INSERT OR IGNORE INTO mail_reply_tokens (token, conversation_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(token, conversationId, userId, new Date().toISOString());
    token = db.prepare('SELECT token FROM mail_reply_tokens WHERE conversation_id = ? AND user_id = ?').pluck().get(conversationId, userId) as string;
  }
  return `reply+${address.key}.${token}@${address.domain}`;
}

/** The new text of a reply: everything above the quoted message it answers. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const end = lines.findIndex((line) =>
    /^\s*>/.test(line) || /^On .+wrote:\s*$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^From: .+/.test(line));
  return (end === -1 ? lines : lines.slice(0, end)).join('\n').trim();
}

type Outcome = { status: 'delivered'; conversationId: string; messageId: string } | { status: 'rejected'; reason: string; conversationId?: string };

function post(db: Database, hub: ConnectionHub, conversationId: string, authorId: string, body: string): string {
  const message = createMessage(db, { conversationId, authorId, authorType: 'user', body, mentions: [], replyToMessageId: null });
  hub.publish(`conversation:${conversationId}`, 'message.created', { ...message });
  enqueueJob(db, {
    type: SUMMARIZE_CONVERSATION_JOB_TYPE,
    payload: { conversationId },
    dedupeKey: `${SUMMARIZE_CONVERSATION_JOB_TYPE}:${conversationId}`,
  });
  return message.id;
}

function processReply(db: Database, hub: ConnectionHub, message: InboundMessage): Outcome {
  const token = db.prepare('SELECT conversation_id, user_id FROM mail_reply_tokens WHERE token = ?').get(message.target) as { conversation_id: string; user_id: string } | undefined;
  if (!token) return { status: 'rejected', reason: 'unknown_reply_address' };
  const user = getUserById(db, token.user_id);
  if (!user || user.suspended_at) return { status: 'rejected', reason: 'unknown_user' };
  // The address is a capability, but only for the person it was given to.
  if (user.email.toLowerCase() !== message.from.email.toLowerCase()) return { status: 'rejected', reason: 'sender_mismatch' };
  if (message.authenticated === false) return { status: 'rejected', reason: 'sender_not_authenticated' };
  if (!getConversation(db, token.conversation_id) || !isParticipant(db, token.conversation_id, user.id, 'user')) {
    return { status: 'rejected', reason: 'not_a_participant' };
  }
  const body = stripQuotedReply(message.text);
  if (!body) return { status: 'rejected', reason: 'empty_reply', conversationId: token.conversation_id };
  return { status: 'delivered', conversationId: token.conversation_id, messageId: post(db, hub, token.conversation_id, user.id, body) };
}

function processRoute(db: Database, hub: ConnectionHub, message: InboundMessage): Outcome {
  const route = db.prepare('SELECT conversation_id, posted_by FROM mail_inbound_routes WHERE address = ?').get(message.recipient.toLowerCase()) as { conversation_id: string; posted_by: string } | undefined;
  if (!route) return { status: 'rejected', reason: 'unknown_route' };
  if (!getConversation(db, route.conversation_id) || !isParticipant(db, route.conversation_id, route.posted_by, 'user')) {
    return { status: 'rejected', reason: 'route_target_gone' };
  }
  const sender = message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email;
  const attachments = message.attachments.length
    ? `\n\nAttachments (not kept): ${message.attachments.map((file) => file.name).join(', ')}`
    : '';
  const warning = message.authenticated === false ? '\n\n(The sender could not be verified.)' : '';
  const body = `Email from ${sender} to ${message.recipient}: ${message.subject || '(no subject)'}\n\n${message.text.trim()}${attachments}${warning}`;
  return { status: 'delivered', conversationId: route.conversation_id, messageId: post(db, hub, route.conversation_id, route.posted_by, body) };
}

/**
 * Takes what Crewly is holding for this server, posts it, and acknowledges
 * each message so Crewly deletes it. A message seen before is only
 * acknowledged again. Returns how many were handled.
 */
export async function pullInboundMail(db: Database, fetchImpl: typeof fetch, hub: ConnectionHub): Promise<number> {
  const answer = await crewlyServiceRequest(db, fetchImpl, 'mail:receive', 'GET', '/api/v1/instance/mail/inbound');
  if (answer.status !== 200) return 0;
  const messages = (answer.body.messages ?? []) as InboundMessage[];
  for (const message of messages) {
    const seen = db.prepare('SELECT status, reason FROM mail_inbound WHERE id = ?').get(message.id) as { status: InboundRecord['status']; reason: string | null } | undefined;
    let outcome: { status: InboundRecord['status']; reason: string | null };
    if (seen) {
      outcome = seen;
    } else {
      const result = message.kind === 'reply' ? processReply(db, hub, message) : processRoute(db, hub, message);
      db.prepare(
        `INSERT INTO mail_inbound (id, kind, sender, recipient, status, reason, conversation_id, message_id, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        message.id, message.kind, message.from.email, message.recipient, result.status,
        result.status === 'rejected' ? result.reason : null,
        result.conversationId ?? null, result.status === 'delivered' ? result.messageId : null,
        message.receivedAt, new Date().toISOString(),
      );
      outcome = { status: result.status, reason: result.status === 'rejected' ? result.reason : null };
    }
    await crewlyServiceRequest(db, fetchImpl, 'mail:receive', 'POST', `/api/v1/instance/mail/inbound/${encodeURIComponent(message.id)}/ack`, {
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
  }
  return messages.length;
}

export function listInboundMail(db: Database, limit: number): InboundRecord[] {
  const rows = db.prepare('SELECT * FROM mail_inbound ORDER BY processed_at DESC, rowid DESC LIMIT ?').all(limit) as Array<{
    id: string; kind: InboundRecord['kind']; sender: string; recipient: string; status: InboundRecord['status']; reason: string | null;
    conversation_id: string | null; message_id: string | null; received_at: string; processed_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    sender: row.sender,
    recipient: row.recipient,
    status: row.status,
    reason: row.reason,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  }));
}
