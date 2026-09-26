import { randomUUID } from 'node:crypto';
import {
  ChannelCategorySchema,
  ChannelSchema,
  type Channel,
  type ChannelCategory,
  type ChannelPostRole,
  type ChannelVisibility,
  type ParticipantRef,
} from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import type { Role } from '../users/repository.js';

interface ChannelRow {
  id: string;
  name: string;
  topic: string | null;
  visibility: ChannelVisibility;
  post_role: ChannelPostRole;
  category_id: string | null;
  position: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CategoryRow {
  id: string;
  name: string;
  position: number;
}

export interface Reader {
  id: string;
  role: Role;
}

const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export function isChannelAdmin(role: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.admin;
}

function members(db: Database, id: string): ParticipantRef[] {
  const rows = db
    .prepare('SELECT participant_id, participant_type FROM conversation_participants WHERE conversation_id = ? ORDER BY added_at')
    .all(id) as { participant_id: string; participant_type: 'user' | 'agent' }[];
  return rows.map((r) => ({ participantId: r.participant_id, participantType: r.participant_type }));
}

export function blockedAgentIds(db: Database, id: string): string[] {
  return db.prepare('SELECT agent_id FROM channel_agent_blocks WHERE conversation_id = ?').pluck().all(id) as string[];
}

function toChannel(db: Database, row: ChannelRow, reader: Reader): Channel {
  const people = members(db, row.id);
  const joined = people.some((m) => m.participantType === 'user' && m.participantId === reader.id);
  return ChannelSchema.parse({
    id: row.id,
    name: row.name,
    topic: row.topic,
    visibility: row.visibility,
    postRole: row.post_role,
    categoryId: row.category_id,
    position: row.position,
    archivedAt: row.archived_at,
    members: people,
    blockedAgentIds: blockedAgentIds(db, row.id),
    joined,
    canPost: joined && !row.archived_at && ROLE_RANK[reader.role] >= ROLE_RANK[row.post_role],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function getRow(db: Database, id: string): ChannelRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ? AND kind = 'channel'").get(id) as ChannelRow | undefined;
}

/**
 * Whether the reader may see a channel at all. A public channel is the
 * server's; a private one is its members'. Admins see private channels they are
 * not in so they can manage them, but reading one still takes membership.
 */
function visibleTo(db: Database, row: ChannelRow, reader: Reader): boolean {
  if (row.visibility === 'public' || isChannelAdmin(reader.role)) return true;
  return isMember(db, row.id, reader.id);
}

export function isMember(db: Database, channelId: string, userId: string): boolean {
  return db
    .prepare("SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND participant_id = ? AND participant_type = 'user'")
    .get(channelId, userId) !== undefined;
}

export function getChannel(db: Database, id: string, reader: Reader): Channel | undefined {
  const row = getRow(db, id);
  if (!row || !visibleTo(db, row, reader)) return undefined;
  return toChannel(db, row, reader);
}

/** Whether the reader may read a channel's history: any public channel, or a private one they are in. */
export function canReadChannel(db: Database, id: string, userId: string): boolean {
  const row = getRow(db, id);
  if (!row) return false;
  return row.visibility === 'public' || isMember(db, id, userId);
}

export function listChannels(db: Database, reader: Reader, opts: { includeArchived?: boolean } = {}): Channel[] {
  const rows = db
    .prepare(
      `SELECT * FROM conversations WHERE kind = 'channel' ${opts.includeArchived ? '' : 'AND archived_at IS NULL'}
       ORDER BY position, name COLLATE NOCASE`
    )
    .all() as ChannelRow[];
  return rows.filter((row) => visibleTo(db, row, reader)).map((row) => toChannel(db, row, reader));
}

export function listCategories(db: Database): ChannelCategory[] {
  const rows = db.prepare('SELECT id, name, position FROM channel_categories ORDER BY position, name COLLATE NOCASE').all() as CategoryRow[];
  return rows.map((row) => ChannelCategorySchema.parse(row));
}

export function getCategory(db: Database, id: string): ChannelCategory | undefined {
  const row = db.prepare('SELECT id, name, position FROM channel_categories WHERE id = ?').get(id) as CategoryRow | undefined;
  return row && ChannelCategorySchema.parse(row);
}

/** Channel names are unique, ignoring case, among channels that are not archived. */
export function channelNameTaken(db: Database, name: string, exceptId?: string): boolean {
  return db
    .prepare("SELECT 1 FROM conversations WHERE kind = 'channel' AND archived_at IS NULL AND name = ? COLLATE NOCASE AND id <> ?")
    .get(name, exceptId ?? '') !== undefined;
}

function nextPosition(db: Database, table: 'conversations' | 'channel_categories', categoryId?: string | null): number {
  const max = table === 'conversations'
    ? db.prepare("SELECT MAX(position) FROM conversations WHERE kind = 'channel' AND category_id IS ?").pluck().get(categoryId ?? null)
    : db.prepare('SELECT MAX(position) FROM channel_categories').pluck().get();
  return typeof max === 'number' ? max + 1 : 0;
}

export function createChannel(
  db: Database,
  input: {
    name: string;
    topic: string | null;
    visibility: ChannelVisibility;
    postRole: ChannelPostRole;
    categoryId: string | null;
    createdBy: string;
    members: ParticipantRef[];
  },
  reader: Reader,
): Channel {
  const now = new Date().toISOString();
  const id = randomUUID();
  const insertMember = db.prepare(
    `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_id, participant_type, added_at)
     VALUES (?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.prepare(
      `INSERT INTO conversations (id, kind, name, topic, visibility, post_role, category_id, position, created_by, created_at, updated_at)
       VALUES (?, 'channel', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.name, input.topic, input.visibility, input.postRole, input.categoryId,
      nextPosition(db, 'conversations', input.categoryId), input.createdBy, now, now);
    for (const m of input.members) insertMember.run(id, m.participantId, m.participantType, now);
  })();
  return toChannel(db, getRow(db, id)!, reader);
}

export function updateChannel(
  db: Database,
  id: string,
  patch: {
    name?: string;
    topic?: string | null;
    visibility?: ChannelVisibility;
    postRole?: ChannelPostRole;
    categoryId?: string | null;
    archived?: boolean;
  },
): void {
  const row = getRow(db, id);
  if (!row) return;
  const now = new Date().toISOString();
  const categoryId = patch.categoryId === undefined ? row.category_id : patch.categoryId;
  const moved = categoryId !== row.category_id;
  db.prepare(
    `UPDATE conversations SET name = ?, topic = ?, visibility = ?, post_role = ?, category_id = ?, position = ?,
       archived_at = ?, updated_at = ? WHERE id = ?`
  ).run(
    patch.name ?? row.name,
    patch.topic === undefined ? row.topic : patch.topic,
    patch.visibility ?? row.visibility,
    patch.postRole ?? row.post_role,
    categoryId,
    moved ? nextPosition(db, 'conversations', categoryId) : row.position,
    patch.archived === undefined ? row.archived_at : patch.archived ? row.archived_at ?? now : null,
    now,
    id,
  );
}

/** Puts the given channels, in this order, into one category (or none). */
export function orderChannels(db: Database, categoryId: string | null, channelIds: string[]): void {
  const now = new Date().toISOString();
  const update = db.prepare("UPDATE conversations SET category_id = ?, position = ?, updated_at = ? WHERE id = ? AND kind = 'channel'");
  db.transaction(() => channelIds.forEach((id, index) => update.run(categoryId, index, now, id)))();
}

export function addMember(db: Database, id: string, member: ParticipantRef): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO conversation_participants (conversation_id, participant_id, participant_type, added_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, member.participantId, member.participantType, now);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);
}

export function removeMember(db: Database, id: string, member: ParticipantRef): void {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND participant_id = ? AND participant_type = ?')
    .run(id, member.participantId, member.participantType);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);
}

export function setAgentBlocked(db: Database, id: string, agentId: string, blocked: boolean, by: string): void {
  db.transaction(() => {
    if (blocked) {
      db.prepare('INSERT OR IGNORE INTO channel_agent_blocks (conversation_id, agent_id, blocked_by, created_at) VALUES (?, ?, ?, ?)')
        .run(id, agentId, by, new Date().toISOString());
      removeMember(db, id, { participantId: agentId, participantType: 'agent' });
    } else {
      db.prepare('DELETE FROM channel_agent_blocks WHERE conversation_id = ? AND agent_id = ?').run(id, agentId);
    }
  })();
}

export function isAgentBlocked(db: Database, id: string, agentId: string): boolean {
  return db.prepare('SELECT 1 FROM channel_agent_blocks WHERE conversation_id = ? AND agent_id = ?').get(id, agentId) !== undefined;
}

export function createCategory(db: Database, name: string): ChannelCategory {
  const id = randomUUID();
  db.prepare('INSERT INTO channel_categories (id, name, position, created_at) VALUES (?, ?, ?, ?)')
    .run(id, name, nextPosition(db, 'channel_categories'), new Date().toISOString());
  return getCategory(db, id)!;
}

export function renameCategory(db: Database, id: string, name: string): void {
  db.prepare('UPDATE channel_categories SET name = ? WHERE id = ?').run(name, id);
}

/** Deleting a category keeps its channels; they move to the uncategorised list. */
export function deleteCategory(db: Database, id: string): void {
  db.transaction(() => {
    const start = nextPosition(db, 'conversations', null);
    const orphans = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' AND category_id = ? ORDER BY position").pluck().all(id) as string[];
    const move = db.prepare('UPDATE conversations SET category_id = NULL, position = ? WHERE id = ?');
    orphans.forEach((channelId, index) => move.run(start + index, channelId));
    db.prepare('DELETE FROM channel_categories WHERE id = ?').run(id);
  })();
}

export function orderCategories(db: Database, ids: string[]): void {
  const update = db.prepare('UPDATE channel_categories SET position = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, index) => update.run(index, id)))();
}

/**
 * A new server opens on a room to talk in. Without one, a fresh server's
 * sidebar had no channel at all and the feature looked absent. Only ever the
 * first channel: a server whose owner deleted #general does not get it back.
 */
export function ensureDefaultChannel(db: Database, owner: Reader): Channel | undefined {
  const any = db.prepare("SELECT 1 FROM conversations WHERE kind = 'channel' LIMIT 1").get();
  if (any) return undefined;
  return createChannel(db, {
    name: 'general',
    topic: 'Company-wide conversation. Everyone on the server can read and post here.',
    visibility: 'public',
    postRole: 'member',
    categoryId: null,
    createdBy: owner.id,
    members: [{ participantId: owner.id, participantType: 'user' }],
  }, owner);
}
