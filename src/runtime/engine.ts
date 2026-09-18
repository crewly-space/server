import { DEFAULT_MAX_HOP_COUNT, type AgentRun, type Message } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';
import { enqueueJob } from '../jobs/repository.js';
import { SUMMARIZE_CONVERSATION_JOB_TYPE } from '../memory/summary.js';
import { createMessage, listRecentMessagesForConversation } from '../messages/repository.js';
import type { ConnectionHub } from '../ws/hub.js';
import { createAgentRun } from './runs.js';

export interface AgentTurnResult {
  body: string;
  handoffToAgentId?: string;
}

export type RespondFn = (input: {
  agentId: string;
  conversationId: string;
  recentMessages: Message[];
}) => Promise<AgentTurnResult>;

export interface RunAgentTurnDeps {
  db: Database;
  hub: ConnectionHub;
  respond: RespondFn;
}

export interface RunAgentTurnInput {
  agentId: string;
  conversationId: string;
  rootRunId?: string;
  causationId?: string | null;
  hopCount?: number;
}

export interface RunAgentTurnOutcome {
  run: AgentRun;
  message: Message;
  handoff: { attempted: boolean; dispatched: boolean; blockedReason?: 'max_hop_count_exceeded' };
}

export class MaxHopCountExceededError extends Error {}

export async function runAgentTurn(deps: RunAgentTurnDeps, input: RunAgentTurnInput): Promise<RunAgentTurnOutcome> {
  const hopCount = input.hopCount ?? 0;
  if (hopCount > DEFAULT_MAX_HOP_COUNT) {
    throw new MaxHopCountExceededError(
      `hopCount ${hopCount} exceeds DEFAULT_MAX_HOP_COUNT (${DEFAULT_MAX_HOP_COUNT})`
    );
  }

  const runId = randomUUID();
  const rootRunId = input.rootRunId ?? runId;
  const causationId = input.causationId ?? null;

  const run = createAgentRun(deps.db, {
    runId,
    rootRunId,
    causationId,
    hopCount,
    agentId: input.agentId,
    conversationId: input.conversationId,
  });

  const recentMessages = listRecentMessagesForConversation(deps.db, input.conversationId, 20);
  const result = await deps.respond({
    agentId: input.agentId,
    conversationId: input.conversationId,
    recentMessages,
  });

  const message = createMessage(deps.db, {
    conversationId: input.conversationId,
    authorId: input.agentId,
    authorType: 'agent',
    body: result.body,
    mentions: [],
    replyToMessageId: null,
  });
  deps.hub.publish(`conversation:${input.conversationId}`, 'message.created', { ...message });
  enqueueJob(deps.db, {
    type: SUMMARIZE_CONVERSATION_JOB_TYPE,
    payload: { conversationId: input.conversationId },
    dedupeKey: `${SUMMARIZE_CONVERSATION_JOB_TYPE}:${input.conversationId}`,
  });

  if (!result.handoffToAgentId) {
    return { run, message, handoff: { attempted: false, dispatched: false } };
  }

  const nextHopCount = hopCount + 1;
  if (nextHopCount > DEFAULT_MAX_HOP_COUNT) {
    return { run, message, handoff: { attempted: true, dispatched: false, blockedReason: 'max_hop_count_exceeded' } };
  }

  const nested = await runAgentTurn(deps, {
    agentId: result.handoffToAgentId,
    conversationId: input.conversationId,
    rootRunId,
    causationId: runId,
    hopCount: nextHopCount,
  });

  return {
    run,
    message,
    handoff: { attempted: true, dispatched: true, blockedReason: nested.handoff.blockedReason },
  };
}
