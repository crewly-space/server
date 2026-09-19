import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { createConversation } from '../conversations/repository.js';
import { createAgentRun, getAgentRun, listAgentRunsForRoot } from './runs.js';

describe('agent runs repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDbWithAgentAndConversation() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-runs-'));
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
    const conversation = createConversation(db, {
      kind: 'dm',
      name: null,
      participants: [
        { participantId: owner.id, participantType: 'user' },
        { participantId: agent.id, participantType: 'agent' },
      ],
    });
    return { db, agent, conversation };
  }

  it('creates a root run with hopCount 0 and reads it back', () => {
    const { db, agent, conversation } = freshDbWithAgentAndConversation();
    const runId = randomUUID();
    const run = createAgentRun(db, {
      runId,
      rootRunId: runId,
      causationId: null,
      hopCount: 0,
      agentId: agent.id,
      conversationId: conversation.id,
    });
    expect(run.hopCount).toBe(0);
    expect(getAgentRun(db, runId)?.runId).toBe(runId);
    db.close();
  });

  it('rejects a run with hopCount above DEFAULT_MAX_HOP_COUNT at the database layer', () => {
    const { db, agent, conversation } = freshDbWithAgentAndConversation();
    expect(() =>
      createAgentRun(db, {
        runId: randomUUID(),
        rootRunId: randomUUID(),
        causationId: null,
        hopCount: 5,
        agentId: agent.id,
        conversationId: conversation.id,
      })
    ).toThrow();
    db.close();
  });

  it('lists a run chain for a root in creation order', () => {
    const { db, agent, conversation } = freshDbWithAgentAndConversation();
    const rootRunId = randomUUID();
    createAgentRun(db, { runId: rootRunId, rootRunId, causationId: null, hopCount: 0, agentId: agent.id, conversationId: conversation.id });
    const hop1 = randomUUID();
    createAgentRun(db, { runId: hop1, rootRunId, causationId: rootRunId, hopCount: 1, agentId: agent.id, conversationId: conversation.id });

    const chain = listAgentRunsForRoot(db, rootRunId);
    expect(chain).toHaveLength(2);
    expect(chain[0].runId).toBe(rootRunId);
    expect(chain[1].runId).toBe(hop1);
    db.close();
  });
});
