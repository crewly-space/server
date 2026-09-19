import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { createRuntimeBinding, getRuntimeBinding, listRuntimeBindingsForAgent } from './bindings.js';

describe('runtime bindings repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDbWithAgent() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-bindings-'));
    const db = openDatabase(dataDir);
    runMigrations(db);
    const owner = createUser(db, { email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    const agent = createAgent(db, {
      ownerUserId: owner.id,
      name: 'Assistant',
      personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    return { db, agent };
  }

  it('creates a native runtime binding and reads it back', () => {
    const { db, agent } = freshDbWithAgent();
    const binding = createRuntimeBinding(db, {
      agentId: agent.id,
      runtimeKind: 'native',
      workspacePath: '/workspaces/assistant',
    });
    expect(binding.runtimeKind).toBe('native');
    expect(getRuntimeBinding(db, binding.id)?.id).toBe(binding.id);
    db.close();
  });

  it('round-trips vendor state without putting it on the Agent row', () => {
    const { db, agent } = freshDbWithAgent();
    const binding = createRuntimeBinding(db, {
      agentId: agent.id,
      runtimeKind: 'claude-code',
      workspacePath: '/workspaces/assistant',
      vendorState: { claudeSessionId: 'sess_abc123' },
    });
    const fetched = getRuntimeBinding(db, binding.id);
    expect(fetched?.vendorState.claudeSessionId).toBe('sess_abc123');
    db.close();
  });

  it('lists bindings for a given agent', () => {
    const { db, agent } = freshDbWithAgent();
    createRuntimeBinding(db, { agentId: agent.id, runtimeKind: 'native', workspacePath: '/a' });
    createRuntimeBinding(db, { agentId: agent.id, runtimeKind: 'native', workspacePath: '/b' });
    expect(listRuntimeBindingsForAgent(db, agent.id)).toHaveLength(2);
    db.close();
  });
});
