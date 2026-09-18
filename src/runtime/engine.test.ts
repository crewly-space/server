import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_HOP_COUNT } from '../protocol/index.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { createConversation } from '../conversations/repository.js';
import { createMessage } from '../messages/repository.js';
import { ConnectionHub } from '../ws/hub.js';
import { runAgentTurn, type AgentTurnResult, type RespondFn } from './engine.js';
import { getAgentRun, listAgentRunsForRoot } from './runs.js';

describe('runAgentTurn (single turn, no handoff)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshSetup() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrew-engine-'));
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
    createMessage(db, {
      conversationId: conversation.id,
      authorId: owner.id,
      authorType: 'user',
      body: 'hello agent',
      mentions: [],
      replyToMessageId: null,
    });
    const hub = new ConnectionHub(db);
    return { db, agent, conversation, hub };
  }

  it('persists a run, calls respond with recent conversation context, and persists+publishes the response as an agent message', async () => {
    const { db, agent, conversation, hub } = freshSetup();
    const respond = vi.fn(async (_input: Parameters<RespondFn>[0]): Promise<AgentTurnResult> => ({ body: 'hello human' }));

    const outcome = await runAgentTurn(
      { db, hub, respond },
      { agentId: agent.id, conversationId: conversation.id }
    );

    expect(respond).toHaveBeenCalledOnce();
    const call = respond.mock.calls[0][0];
    expect(call.agentId).toBe(agent.id);
    expect(call.recentMessages).toHaveLength(1);
    expect(call.recentMessages[0].body).toBe('hello agent');

    expect(outcome.message.authorType).toBe('agent');
    expect(outcome.message.authorId).toBe(agent.id);
    expect(outcome.message.body).toBe('hello human');
    expect(outcome.run.hopCount).toBe(0);
    expect(outcome.handoff).toEqual({ attempted: false, dispatched: false });

    expect(getAgentRun(db, outcome.run.runId)?.runId).toBe(outcome.run.runId);
    db.close();
  });

  it('stops an agent-to-agent handoff chain at the max hop count instead of looping forever', async () => {
    const { db, agent, conversation, hub } = freshSetup();
    const selfHandoffRespond = vi.fn(
      async (): Promise<AgentTurnResult> => ({
        body: 'still thinking, handing off to myself',
        handoffToAgentId: agent.id,
      })
    );

    const outcome = await runAgentTurn(
      { db, hub, respond: selfHandoffRespond },
      { agentId: agent.id, conversationId: conversation.id }
    );

    const chain = listAgentRunsForRoot(db, outcome.run.rootRunId);
    expect(chain).toHaveLength(DEFAULT_MAX_HOP_COUNT + 1);
    expect(chain.map((r) => r.hopCount)).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].causationId).toBe(chain[i - 1].runId);
    }
    // 5 recursive calls each attempted a handoff; only the first 4 (hop 0-3)
    // could dispatch a follow-up (into hops 1-4); the hop-4 call's attempted
    // handoff to hop 5 was blocked, never persisted.
    expect(selfHandoffRespond).toHaveBeenCalledTimes(5);
    db.close();
  });

  it('propagates a downstream max-hop-count block up to the top-level caller', async () => {
    const { db, agent, conversation, hub } = freshSetup();
    const selfHandoffRespond = vi.fn(
      async (): Promise<AgentTurnResult> => ({
        body: 'still thinking, handing off to myself',
        handoffToAgentId: agent.id,
      })
    );

    const outcome = await runAgentTurn(
      { db, hub, respond: selfHandoffRespond },
      { agentId: agent.id, conversationId: conversation.id }
    );

    expect(outcome.handoff).toEqual({
      attempted: true,
      dispatched: true,
      blockedReason: 'max_hop_count_exceeded',
    });
    db.close();
  });

  it('enqueues a summarize-conversation job after persisting the agent message', async () => {
    const { db, agent, conversation, hub } = freshSetup();
    const respond = vi.fn(async (): Promise<AgentTurnResult> => ({ body: 'hello human' }));

    await runAgentTurn({ db, hub, respond }, { agentId: agent.id, conversationId: conversation.id });

    const row = db.prepare("SELECT status FROM jobs WHERE type = 'summarize-conversation'").get() as
      | { status: string }
      | undefined;
    expect(row?.status).toBe('pending');
    db.close();
  });
});
