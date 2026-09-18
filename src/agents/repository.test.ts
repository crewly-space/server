import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent, getAgent, listAgentsForOwner } from './repository.js';

describe('agents repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDbWithUser() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrew-agents-'));
    const db = openDatabase(dataDir);
    runMigrations(db);
    const user = createUser(db, {
      email: 'owner@example.com',
      displayName: 'Owner',
      passwordHash: 'x',
      role: 'owner',
    });
    return { db, user };
  }

  it('creates an agent that round-trips through the shared protocol schema', () => {
    const { db, user } = freshDbWithUser();
    const agent = createAgent(db, {
      ownerUserId: user.id,
      name: 'Researcher',
      personality: 'Curious and terse.',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    expect(agent.name).toBe('Researcher');
    expect(getAgent(db, agent.id)?.id).toBe(agent.id);
    db.close();
  });

  it('lists only the agents owned by the given user', () => {
    const { db, user } = freshDbWithUser();
    const otherUser = createUser(db, {
      email: 'other@example.com',
      displayName: 'Other',
      passwordHash: 'y',
      role: 'member',
    });
    createAgent(db, {
      ownerUserId: user.id,
      name: 'Mine',
      personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    createAgent(db, {
      ownerUserId: otherUser.id,
      name: 'TheirsNotMine',
      personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    const mine = listAgentsForOwner(db, user.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe('Mine');
    db.close();
  });
});
