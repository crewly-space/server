import { MemoryFactSchema, type MemoryFact } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';

interface MemoryFactRow {
  id: string;
  agent_id: string;
  content: string;
  content_key: string;
  source: 'conversation' | 'manual' | 'summary';
  tags: string;
  created_at: string;
  updated_at: string;
}

function normalize(content: string): string {
  return content.trim().toLowerCase();
}

function rowToMemoryFact(row: MemoryFactRow): MemoryFact {
  return MemoryFactSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    content: row.content,
    source: row.source,
    tags: JSON.parse(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createMemoryFact(
  db: Database,
  input: { agentId: string; content: string; source: 'conversation' | 'manual' | 'summary'; tags?: string[] }
): { fact: MemoryFact; created: boolean } {
  const now = new Date().toISOString();
  const contentKey = normalize(input.content);
  const row = {
    id: randomUUID(),
    agent_id: input.agentId,
    content: input.content,
    content_key: contentKey,
    source: input.source,
    tags: JSON.stringify(input.tags ?? []),
    created_at: now,
    updated_at: now,
  };
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO memory_facts (id, agent_id, content, content_key, source, tags, created_at, updated_at)
       VALUES (@id, @agent_id, @content, @content_key, @source, @tags, @created_at, @updated_at)`
    )
    .run(row);
  const created = result.changes === 1;
  const existing = db
    .prepare('SELECT * FROM memory_facts WHERE agent_id = ? AND content_key = ?')
    .get(input.agentId, contentKey) as MemoryFactRow;
  return { fact: rowToMemoryFact(existing), created };
}

export function listMemoryFactsForAgent(db: Database, agentId: string): MemoryFact[] {
  const rows = db
    .prepare('SELECT * FROM memory_facts WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(agentId) as MemoryFactRow[];
  return rows.map(rowToMemoryFact);
}

export function getMemoryFact(db: Database, id: string): MemoryFact | undefined {
  const row = db.prepare('SELECT * FROM memory_facts WHERE id = ?').get(id) as MemoryFactRow | undefined;
  return row ? rowToMemoryFact(row) : undefined;
}

export function updateMemoryFact(
  db: Database,
  id: string,
  input: { content?: string; tags?: string[] }
): MemoryFact | undefined {
  const existing = db.prepare('SELECT * FROM memory_facts WHERE id = ?').get(id) as MemoryFactRow | undefined;
  if (!existing) return undefined;

  const now = new Date().toISOString();
  const content = input.content ?? existing.content;
  const contentKey = normalize(content);
  const tags = input.tags ?? (JSON.parse(existing.tags) as string[]);

  if (contentKey !== existing.content_key) {
    const collision = db
      .prepare('SELECT * FROM memory_facts WHERE agent_id = ? AND content_key = ? AND id != ?')
      .get(existing.agent_id, contentKey, id) as MemoryFactRow | undefined;
    if (collision) {
      db.prepare('DELETE FROM memory_facts WHERE id = ?').run(id);
      return rowToMemoryFact(collision);
    }
  }

  db.prepare(`UPDATE memory_facts SET content = ?, content_key = ?, tags = ?, updated_at = ? WHERE id = ?`).run(
    content,
    contentKey,
    JSON.stringify(tags),
    now,
    id
  );
  return getMemoryFact(db, id);
}

export function deleteMemoryFact(db: Database, id: string): void {
  db.prepare('DELETE FROM memory_facts WHERE id = ?').run(id);
}
