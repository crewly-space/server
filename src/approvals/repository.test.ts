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
import { createAgentRun } from '../runtime/runs.js';
import { ApprovalAlreadyResolvedError, createApproval, getApproval, listPendingApprovals, resolveApproval } from './repository.js';

describe('approvals repository', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshSetup() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-approvals-'));
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
    const runId = randomUUID();
    const run = createAgentRun(db, {
      runId,
      rootRunId: runId,
      causationId: null,
      hopCount: 0,
      agentId: agent.id,
      conversationId: conversation.id,
    });
    return { db, agent, run };
  }

  it('creates a pending approval and lists it', () => {
    const { db, agent, run } = freshSetup();
    const approval = createApproval(db, {
      runId: run.runId,
      agentId: agent.id,
      action: 'send_email',
      details: { to: 'user@example.com' },
    });
    expect(approval.status).toBe('pending');
    expect(listPendingApprovals(db)).toHaveLength(1);
    db.close();
  });

  it('resolves an approval as approved and sets resolvedAt', () => {
    const { db, agent, run } = freshSetup();
    const approval = createApproval(db, { runId: run.runId, agentId: agent.id, action: 'send_email', details: {} });
    const resolved = resolveApproval(db, approval.id, 'approve');
    expect(resolved.status).toBe('approved');
    expect(resolved.resolvedAt).not.toBeNull();
    expect(listPendingApprovals(db)).toHaveLength(0);
    db.close();
  });

  it('resolves an approval as denied', () => {
    const { db, agent, run } = freshSetup();
    const approval = createApproval(db, { runId: run.runId, agentId: agent.id, action: 'send_email', details: {} });
    const resolved = resolveApproval(db, approval.id, 'deny');
    expect(resolved.status).toBe('denied');
    db.close();
  });

  it('rejects resolving an already-resolved approval', () => {
    const { db, agent, run } = freshSetup();
    const approval = createApproval(db, { runId: run.runId, agentId: agent.id, action: 'send_email', details: {} });
    resolveApproval(db, approval.id, 'approve');
    expect(() => resolveApproval(db, approval.id, 'deny')).toThrow(ApprovalAlreadyResolvedError);
    db.close();
  });
});
