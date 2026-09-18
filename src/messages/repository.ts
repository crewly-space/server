import { MessageSchema, type ActorType, type MentionRef, type Message } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';

interface MessageRow {
  id: string;
  conversation_id: string;
  author_id: string;
  author_type: ActorType;
  body: string;
  reply_to_message_id: string | null;
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

function rowToMessage(row: MessageRow, mentions: MentionRef[]): Message {
  return MessageSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    authorId: row.author_id,
    authorType: row.author_type,
    body: row.body,
    mentions,
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
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
  }
): Message {
  if (input.replyToMessageId) {
    const replyTarget = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(input.replyToMessageId) as
      | { conversation_id: string }
      | undefined;
    if (!replyTarget || replyTarget.conversation_id !== input.conversationId) {
      throw new ReplyNotInConversationError('replyToMessageId must reference a message in the same conversation');
    }
  }

  const now = new Date().toISOString();
  const row: MessageRow = {
    id: randomUUID(),
    conversation_id: input.conversationId,
    author_id: input.authorId,
    author_type: input.authorType,
    body: input.body,
    reply_to_message_id: input.replyToMessageId,
    created_at: now,
  };
  const insertMessage = db.prepare(
    `INSERT INTO messages (id, conversation_id, author_id, author_type, body, reply_to_message_id, created_at)
     VALUES (@id, @conversation_id, @author_id, @author_type, @body, @reply_to_message_id, @created_at)`
  );
  const insertMention = db.prepare('INSERT INTO message_mentions (message_id, target_id, target_type) VALUES (?, ?, ?)');
  const touchConversation = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');
  const createTx = db.transaction(() => {
    insertMessage.run(row);
    for (const m of input.mentions) {
      insertMention.run(row.id, m.targetId, m.targetType);
    }
    touchConversation.run(now, input.conversationId);
  });
  createTx();
  return rowToMessage(row, input.mentions);
}

export function listMessagesForConversation(db: Database, conversationId: string, limit = 50): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(conversationId, limit) as MessageRow[];
  return rows.reverse().map((row) => rowToMessage(row, getMentions(db, row.id)));
}

export function listRecentMessagesForConversation(db: Database, conversationId: string, limit = 20): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(conversationId, limit) as MessageRow[];
  return rows.reverse().map((row) => rowToMessage(row, getMentions(db, row.id)));
}
