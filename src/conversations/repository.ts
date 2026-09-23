import { ConversationSchema, type ActorType, type Conversation, type ParticipantRef } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';

interface ConversationRow {
  id: string;
  kind: 'dm' | 'group' | 'channel';
  name: string | null;
  created_at: string;
  updated_at: string;
}

interface ParticipantRow {
  conversation_id: string;
  participant_id: string;
  participant_type: ActorType;
  added_at: string;
}

function getParticipants(db: Database, conversationId: string): ParticipantRef[] {
  const rows = db
    .prepare('SELECT * FROM conversation_participants WHERE conversation_id = ?')
    .all(conversationId) as ParticipantRow[];
  return rows.map((r) => ({ participantId: r.participant_id, participantType: r.participant_type }));
}

function rowToConversation(row: ConversationRow, participants: ParticipantRef[]): Conversation {
  return ConversationSchema.parse({
    id: row.id,
    kind: row.kind,
    name: row.name,
    participants,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createConversation(
  db: Database,
  input: { kind: 'dm' | 'group'; name: string | null; participants: ParticipantRef[] }
): Conversation {
  const now = new Date().toISOString();
  const row: ConversationRow = {
    id: randomUUID(),
    kind: input.kind,
    name: input.name,
    created_at: now,
    updated_at: now,
  };
  const insertConversation = db.prepare(
    `INSERT INTO conversations (id, kind, name, created_at, updated_at)
     VALUES (@id, @kind, @name, @created_at, @updated_at)`
  );
  const insertParticipant = db.prepare(
    `INSERT INTO conversation_participants (conversation_id, participant_id, participant_type, added_at)
     VALUES (?, ?, ?, ?)`
  );
  const createTx = db.transaction(() => {
    insertConversation.run(row);
    for (const p of input.participants) {
      insertParticipant.run(row.id, p.participantId, p.participantType, now);
    }
  });
  createTx();
  return rowToConversation(row, input.participants);
}

export function getConversation(db: Database, id: string): Conversation | undefined {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
  if (!row) return undefined;
  return rowToConversation(row, getParticipants(db, id));
}

export function findDmConversation(
  db: Database,
  participantAId: string,
  participantBId: string
): Conversation | undefined {
  const row = db
    .prepare(
      `SELECT c.* FROM conversations c
       WHERE c.kind = 'dm'
         AND EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.participant_id = ?)
         AND EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.participant_id = ?)`
    )
    .get(participantAId, participantBId) as ConversationRow | undefined;
  if (!row) return undefined;
  return rowToConversation(row, getParticipants(db, row.id));
}

export function isParticipant(
  db: Database,
  conversationId: string,
  participantId: string,
  participantType: ActorType
): boolean {
  const row = db
    .prepare(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND participant_id = ? AND participant_type = ?'
    )
    .get(conversationId, participantId, participantType);
  return row !== undefined;
}

/**
 * The conversations someone is in. Channels are left out unless asked for:
 * they are listed through the channel routes, and a client from before
 * channels would not know what to make of one.
 */
export function listConversationsForParticipant(
  db: Database,
  participantId: string,
  opts: { includeChannels?: boolean } = {}
): Conversation[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id
       WHERE cp.participant_id = ? ${opts.includeChannels ? '' : "AND c.kind <> 'channel'"}
       ORDER BY c.updated_at DESC`
    )
    .all(participantId) as ConversationRow[];
  return rows.map((row) => rowToConversation(row, getParticipants(db, row.id)));
}

export function addParticipant(db: Database, conversationId: string, participant: ParticipantRef): void {
  db.prepare(
    `INSERT INTO conversation_participants (conversation_id, participant_id, participant_type, added_at)
     VALUES (?, ?, ?, ?)`
  ).run(conversationId, participant.participantId, participant.participantType, new Date().toISOString());
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), conversationId);
}

export function removeParticipant(db: Database, conversationId: string, participantId: string): void {
  db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND participant_id = ?').run(
    conversationId,
    participantId
  );
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), conversationId);
}
