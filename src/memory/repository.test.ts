import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { createMemoryFact, deleteMemoryFact, getMemoryFact, listMemoryFactsForAgent, updateMemoryFact } from './repository.js';

describe('memory facts repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDbWithAgent() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrew-memory-'));
    const db = openDatabase(dataDir);
    runMigrations(db);
    const owner = createUser(db, { email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    const agent = createAgent(db, {
      ownerUserId: owner.id,
      name: 'Researcher',
      personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    return { db, owner, agent };
  }

  it('creates a memory fact that round-trips through the shared protocol schema', () => {
    const { db, agent } = freshDbWithAgent();
    const { fact, created } = createMemoryFact(db, { agentId: agent.id, content: 'Prefers concise answers.', source: 'manual' });
    expect(created).toBe(true);
    expect(fact.content).toBe('Prefers concise answers.');
    expect(fact.tags).toEqual([]);
    expect(getMemoryFact(db, fact.id)?.id).toBe(fact.id);
    db.close();
  });

  it('deduplicates by normalized content per agent instead of creating a second row', () => {
    const { db, agent } = freshDbWithAgent();
    const first = createMemoryFact(db, { agentId: agent.id, content: 'Likes dark mode.', source: 'manual' });
    const second = createMemoryFact(db, { agentId: agent.id, content: '  LIKES dark mode.  ', source: 'conversation' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.fact.id).toBe(first.fact.id);
    expect(listMemoryFactsForAgent(db, agent.id)).toHaveLength(1);
    db.close();
  });

  it('lets the same content be stored separately per distinct agent', () => {
    const { db, owner, agent } = freshDbWithAgent();
    const otherAgent = createAgent(db, {
      ownerUserId: owner.id,
      name: 'Second',
      personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    createMemoryFact(db, { agentId: agent.id, content: 'Shared fact.', source: 'manual' });
    const second = createMemoryFact(db, { agentId: otherAgent.id, content: 'Shared fact.', source: 'manual' });
    expect(second.created).toBe(true);
    db.close();
  });

  it('updates content and tags, refreshing the dedup key', () => {
    const { db, agent } = freshDbWithAgent();
    const { fact } = createMemoryFact(db, { agentId: agent.id, content: 'Original.', source: 'manual', tags: ['a'] });
    const updated = updateMemoryFact(db, fact.id, { content: 'Revised.', tags: ['a', 'b'] });
    expect(updated?.content).toBe('Revised.');
    expect(updated?.tags).toEqual(['a', 'b']);
    db.close();
  });

  it('merges an update into an existing fact when the new content collides with it', () => {
    const { db, agent } = freshDbWithAgent();
    const { fact: keep } = createMemoryFact(db, { agentId: agent.id, content: 'Keep me.', source: 'manual' });
    const { fact: editMe } = createMemoryFact(db, { agentId: agent.id, content: 'Edit me.', source: 'manual' });

    const result = updateMemoryFact(db, editMe.id, { content: 'Keep me.' });

    expect(result?.id).toBe(keep.id);
    expect(getMemoryFact(db, editMe.id)).toBeUndefined();
    expect(listMemoryFactsForAgent(db, agent.id)).toHaveLength(1);
    db.close();
  });

  it('deletes a memory fact', () => {
    const { db, agent } = freshDbWithAgent();
    const { fact } = createMemoryFact(db, { agentId: agent.id, content: 'Temporary.', source: 'manual' });
    deleteMemoryFact(db, fact.id);
    expect(getMemoryFact(db, fact.id)).toBeUndefined();
    db.close();
  });
});
