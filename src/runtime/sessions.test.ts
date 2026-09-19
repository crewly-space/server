import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { createConversation } from '../conversations/repository.js';
import { createRuntimeBinding, getRuntimeBinding } from './bindings.js';
import { createRuntimeSession, getRuntimeSession, updateRuntimeSessionStatus } from './sessions.js';

describe('runtime sessions repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshDbWithAgentAndConversation() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-sessions-'));
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
    const binding = createRuntimeBinding(db, { agentId: agent.id, runtimeKind: 'native', workspacePath: '/ws' });
    return { db, owner, agent, conversation, binding };
  }

  it('creates a session that composes agent + conversation + runtime + workspace', () => {
    const { db, agent, conversation, binding } = freshDbWithAgentAndConversation();
    const session = createRuntimeSession(db, {
      agentId: agent.id,
      conversationId: conversation.id,
      runtimeBindingId: binding.id,
    });
    expect(session.status).toBe('idle');

    const fetched = getRuntimeSession(db, session.id);
    expect(fetched?.agentId).toBe(agent.id);
    expect(fetched?.conversationId).toBe(conversation.id);
    const fetchedBinding = getRuntimeBinding(db, fetched!.runtimeBindingId);
    expect(fetchedBinding?.workspacePath).toBe('/ws');
    db.close();
  });

  it('updates session status idle -> running -> closed', () => {
    const { db, agent, conversation, binding } = freshDbWithAgentAndConversation();
    const session = createRuntimeSession(db, {
      agentId: agent.id,
      conversationId: conversation.id,
      runtimeBindingId: binding.id,
    });
    updateRuntimeSessionStatus(db, session.id, 'running');
    expect(getRuntimeSession(db, session.id)?.status).toBe('running');
    updateRuntimeSessionStatus(db, session.id, 'closed');
    expect(getRuntimeSession(db, session.id)?.status).toBe('closed');
    db.close();
  });
});
