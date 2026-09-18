import { ConversationSummarySchema, type ConversationSummary } from '../protocol/index.js';
import type { Database } from '../db/driver.js';

interface ConversationSummaryRow {
  conversation_id: string;
  summary: string;
  up_to_message_id: string;
  updated_at: string;
}

function rowToSummary(row: ConversationSummaryRow): ConversationSummary {
  return ConversationSummarySchema.parse({
    conversationId: row.conversation_id,
    summary: row.summary,
    upToMessageId: row.up_to_message_id,
    updatedAt: row.updated_at,
  });
}

export function getConversationSummary(db: Database, conversationId: string): ConversationSummary | undefined {
  const row = db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(conversationId) as
    | ConversationSummaryRow
    | undefined;
  return row ? rowToSummary(row) : undefined;
}

export function upsertConversationSummary(
  db: Database,
  input: { conversationId: string; summary: string; upToMessageId: string }
): ConversationSummary {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO conversation_summaries (conversation_id, summary, up_to_message_id, updated_at)
     VALUES (@conversation_id, @summary, @up_to_message_id, @updated_at)
     ON CONFLICT(conversation_id) DO UPDATE SET
       summary = excluded.summary,
       up_to_message_id = excluded.up_to_message_id,
       updated_at = excluded.updated_at`
  ).run({ conversation_id: input.conversationId, summary: input.summary, up_to_message_id: input.upToMessageId, updated_at: now });
  return getConversationSummary(db, input.conversationId)!;
}
