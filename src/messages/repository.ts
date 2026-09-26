import { MessageSchema, type ActorType, type MentionRef, type Message } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';
import { attachToMessage, listAttachmentsForMessage, type AttachmentView } from '../attachments/service.js';

interface MessageRow {
  id: string;
  conversation_id: string;
  author_id: string;
  author_type: ActorType;
  body: string;
  reply_to_message_id: string | null;
  thread_root_id: string | null;
  created_at: string;
}

interface MentionRow {
  message_id: string;
  target_id: string;
  target_type: ActorType;
}

export class ReplyNotInConversationError extends Error {}

function getMentions(db: Database, messageId: string): MentionRef[] {
  const rows = db.prepare('SELECT * FROM message_mentions WHERE message_id = ?').all(messageId) as MentionRow[];
  return rows.map((r) => ({ targetId: r.target_id, targetType: r.target_type }));
}

interface ThreadSummaryRow { status: 'open' | 'resolved' | 'archived'; updated_at: string; reply_count: number; last_read_at: string | null; }

function threadSummary(db: Database, messageId: string, userId?: string): Message['thread'] {
  const row = db.prepare(`SELECT t.status, t.updated_at,
      (SELECT COUNT(*) FROM messages r WHERE r.thread_root_id = t.root_message_id) AS reply_count,
      (SELECT last_read_at FROM message_thread_reads WHERE root_message_id = t.root_message_id AND user_id = ?) AS last_read_at
    FROM message_threads t WHERE t.root_message_id = ?`).get(userId ?? '', messageId) as ThreadSummaryRow | undefined;
  return row ? { status: row.status, replyCount: row.reply_count, latestActivityAt: row.updated_at,
    unread: Boolean(userId && (!row.last_read_at || row.updated_at > row.last_read_at)) } : null;
}

function rowToMessage(db: Database, row: MessageRow, mentions: MentionRef[], attachments: AttachmentView[] = [], userId?: string): Message {
  return MessageSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    authorId: row.author_id,
    authorType: row.author_type,
    body: row.body,
    mentions,
    replyToMessageId: row.reply_to_message_id,
    threadRootId: row.thread_root_id,
    thread: threadSummary(db, row.id, userId),
    createdAt: row.created_at,
    attachments,
  });
}

export function createMessage(
  db: Database,
  input: {
    conversationId: string;
    authorId: string;
    authorType: ActorType;
    body: string;
    mentions: MentionRef[];
    replyToMessageId: string | null;
    threadRootId?: string | null;
    attachmentIds?: string[];
    attachmentOwnerId?: string;
  }
): Message {
  if (!input.body.trim() && !input.attachmentIds?.length) {
    throw new Error('message_body_or_attachment_required');
  }
  if (input.replyToMessageId) {
    const replyTarget = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(input.replyToMessageId) as
      | { conversation_id: string }
      | undefined;
    if (!replyTarget || replyTarget.conversation_id !== input.conversationId) {
      throw new ReplyNotInConversationError('replyToMessageId must reference a message in the same conversation');
    }
  }
  if (input.threadRootId) {
    const root = db.prepare('SELECT conversation_id FROM message_threads WHERE root_message_id = ?').get(input.threadRootId) as { conversation_id: string } | undefined;
    if (!root || root.conversation_id !== input.conversationId) throw new ReplyNotInConversationError('threadRootId must reference a thread in the same conversation');
  }

  const now = new Date().toISOString();
  const row: MessageRow = {
    id: randomUUID(),
    conversation_id: input.conversationId,
    author_id: input.authorId,
    author_type: input.authorType,
    body: input.body,
    reply_to_message_id: input.replyToMessageId,
    thread_root_id: input.threadRootId ?? null,
    created_at: now,
  };
  const insertMessage = db.prepare(
    `INSERT INTO messages (id, conversation_id, author_id, author_type, body, reply_to_message_id, thread_root_id, created_at)
     VALUES (@id, @conversation_id, @author_id, @author_type, @body, @reply_to_message_id, @thread_root_id, @created_at)`
  );
  const insertMention = db.prepare('INSERT INTO message_mentions (message_id, target_id, target_type) VALUES (?, ?, ?)');
  const touchConversation = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');
  const createTx = db.transaction(() => {
    insertMessage.run(row);
    for (const m of input.mentions) {
      insertMention.run(row.id, m.targetId, m.targetType);
    }
    if (input.attachmentIds?.length) {
      attachToMessage(db, {
        messageId: row.id,
        conversationId: input.conversationId,
        uploadedBy: input.attachmentOwnerId ?? input.authorId,
        attachmentIds: input.attachmentIds,
      });
    }
    touchConversation.run(now, input.conversationId);
    if (input.threadRootId) db.prepare('UPDATE message_threads SET updated_at = ? WHERE root_message_id = ?').run(now, input.threadRootId);
  });
  createTx();
  return rowToMessage(db, row, input.mentions, listAttachmentsForMessage(db, row.id));
}

export function listMessagesForConversation(db: Database, conversationId: string, limit = 50, userId?: string): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? AND thread_root_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(conversationId, limit) as MessageRow[];
  return rows.reverse().map((row) => rowToMessage(db, row, getMentions(db, row.id), listAttachmentsForMessage(db, row.id), userId));
}

export function listRecentMessagesForConversation(db: Database, conversationId: string, limit = 20): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(conversationId, limit) as MessageRow[];
  return rows.reverse().map((row) => rowToMessage(db, row, getMentions(db, row.id), listAttachmentsForMessage(db, row.id)));
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

interface ThreadRow { root_message_id: string; conversation_id: string; status: MessageThread['status']; created_by: string; created_at: string; updated_at: string; resolved_at: string | null; archived_at: string | null; }
const threadView = (row: ThreadRow): MessageThread => ({ rootMessageId: row.root_message_id, conversationId: row.conversation_id,
  status: row.status, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  resolvedAt: row.resolved_at, archivedAt: row.archived_at });

export function openMessageThread(db: Database, rootMessageId: string, actorId: string): MessageThread {
  const root = db.prepare('SELECT conversation_id, thread_root_id FROM messages WHERE id = ?').get(rootMessageId) as { conversation_id: string; thread_root_id: string | null } | undefined;
  if (!root || root.thread_root_id) throw new Error('thread_root_not_found');
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO message_threads (root_message_id, conversation_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(rootMessageId, root.conversation_id, actorId, now, now);
  return threadView(db.prepare('SELECT * FROM message_threads WHERE root_message_id = ?').get(rootMessageId) as ThreadRow);
}

export function getMessageThread(db: Database, rootMessageId: string): MessageThread | undefined {
  const row = db.prepare('SELECT * FROM message_threads WHERE root_message_id = ?').get(rootMessageId) as ThreadRow | undefined;
  return row ? threadView(row) : undefined;
}

export function listThreadMessages(db: Database, rootMessageId: string, limit = 100, userId?: string): Message[] {
  const root = db.prepare('SELECT * FROM messages WHERE id = ?').get(rootMessageId) as MessageRow | undefined;
  if (!root) return [];
  const replies = db.prepare('SELECT * FROM messages WHERE thread_root_id = ? ORDER BY created_at, rowid LIMIT ?').all(rootMessageId, limit) as MessageRow[];
  return [root, ...replies].map((row) => rowToMessage(db, row, getMentions(db, row.id), listAttachmentsForMessage(db, row.id), userId));
}

export function setThreadStatus(db: Database, rootMessageId: string, status: MessageThread['status']): MessageThread | undefined {
  const now = new Date().toISOString();
  db.prepare(`UPDATE message_threads SET status = ?, updated_at = ?, resolved_at = ?, archived_at = ? WHERE root_message_id = ?`)
    .run(status, now, status === 'resolved' ? now : null, status === 'archived' ? now : null, rootMessageId);
  return getMessageThread(db, rootMessageId);
}

export function markThreadRead(db: Database, rootMessageId: string, userId: string): void {
  db.prepare(`INSERT INTO message_thread_reads (root_message_id, user_id, last_read_at) VALUES (?, ?, ?)
    ON CONFLICT(root_message_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at`)
    .run(rootMessageId, userId, new Date().toISOString());
}

export function searchMessages(db: Database, query: string, userId: string, limit = 50): Message[] {
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = db.prepare(`SELECT m.* FROM messages m
    JOIN conversation_participants p ON p.conversation_id = m.conversation_id
    WHERE p.participant_id = ? AND p.participant_type = 'user' AND m.body LIKE ? ESCAPE '\\'
    ORDER BY m.created_at DESC LIMIT ?`).all(userId, pattern, limit) as MessageRow[];
  return rows.map((row) => rowToMessage(db, row, getMentions(db, row.id), listAttachmentsForMessage(db, row.id), userId));
}
