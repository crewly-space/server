import { DEFAULT_MAX_HOP_COUNT, type AgentRun, type Message } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';
import { enqueueJob } from '../jobs/repository.js';
import { SUMMARIZE_CONVERSATION_JOB_TYPE } from '../memory/summary.js';
import { createMessage, listRecentMessagesForConversation } from '../messages/repository.js';
import type { ConnectionHub } from '../ws/hub.js';
import type { GatewayEvent } from '../gateway/gateway.js';
import { ProviderError } from '../providers/errors.js';
import type { AgentRunQueue } from './queue.js';
import { conversationPeople, emitNotification } from '../notifications/service.js';
import {
  appendRunEvent,
  completeAgentRun,
  createAgentRun,
  failAgentRun,
  getAgentRun,
  isRunCancelled,
  startAgentRun,
} from './runs.js';

export interface AgentTurnResult {
  body: string;
  handoffToAgentId?: string;
  artifactIds?: string[];
}

export interface RespondInput {
  agentId: string;
  conversationId: string;
  recentMessages: Message[];
  /** The run this turn belongs to, so what it spends and does can be traced to it. */
  run?: { runId: string; rootRunId: string; hopCount: number };
  /** Artifact publication is disabled for delegated turns that return to another agent. */
  allowArtifacts?: boolean;
  /** Hears provider calls, retries, fallbacks and tool calls as they happen. */
  onEvent?: (event: TurnEvent) => void;
  /** True once the run has been cancelled; a responder stops at its next step. */
  isCancelled?: () => boolean;
}

/** One tool the model called during a turn. Sizes only: contents stay out of the trace. */
export interface ToolCallEvent {
  type: 'tool.call';
  toolCallId: string;
  name: string;
  status: 'ok' | 'error';
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
}

export type TurnEvent = GatewayEvent | ToolCallEvent;

export type RespondFn = (input: RespondInput) => Promise<AgentTurnResult>;

export interface RunAgentTurnDeps {
  db: Database;
  hub: ConnectionHub;
  respond: RespondFn;
  /** Serialises an agent's top-level runs; without one, runs go straight through. */
  queue?: AgentRunQueue;
  /** Told whenever something that moves an agent's status happened. */
  onAgentChange?: (agentId: string) => void;
}

export interface RunAgentTurnInput {
  agentId: string;
  conversationId: string;
  rootRunId?: string;
  causationId?: string | null;
  hopCount?: number;
  /** What started the run, for the trace: `message`, `delegation`, `api`. */
  trigger?: string;
  triggerMessageId?: string | null;
  /** Why this message woke the agent, retained in the run trace for debugging. */
  routingDecision?: { mode: string; reason: string };
}

/** A run another agent asked for: it sees only the task, and its answer goes back, not into the chat. */
export interface DelegatedTurnInput extends RunAgentTurnInput {
  rootRunId: string;
  causationId: string;
  hopCount: number;
  task: { text: string; fromAgentId: string };
}

type Delivery = { kind: 'post' } | { kind: 'return'; task: DelegatedTurnInput['task'] };

interface TurnResult {
  run: AgentRun;
  message: Message | null;
  body: string;
  handoff: RunAgentTurnOutcome['handoff'];
}

export interface RunAgentTurnOutcome {
  run: AgentRun;
  message: Message;
  handoff: { attempted: boolean; dispatched: boolean; blockedReason?: 'max_hop_count_exceeded' };
}

export class MaxHopCountExceededError extends Error {}

/** The run was cancelled while it was working; its answer is thrown away. */
export class RunCancelledError extends Error {
  readonly code = 'cancelled';
}

const failedRuns = new WeakMap<object, string>();

/** The run a turn's failure belongs to, so whoever reports it can link to the trace. */
export function runIdOfFailure(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? failedRuns.get(error) : undefined;
}

function failureOf(error: unknown): { code: string; message: string } {
  if (error instanceof ProviderError || error instanceof RunCancelledError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'agent_run_failed', message: error instanceof Error ? error.message : String(error) };
}

export async function runAgentTurn(deps: RunAgentTurnDeps, input: RunAgentTurnInput): Promise<RunAgentTurnOutcome> {
  const result = await runTurn(deps, input, { kind: 'post' });
  return { run: result.run, message: result.message!, handoff: result.handoff };
}

/**
 * Runs a subtask for another agent and hands the answer back. Nothing is
 * posted to the conversation: the delegating agent decides what to say.
 */
export async function runDelegatedTurn(deps: RunAgentTurnDeps, input: DelegatedTurnInput): Promise<{ run: AgentRun; body: string }> {
  const result = await runTurn(deps, { ...input, trigger: 'delegation' }, { kind: 'return', task: input.task });
  return { run: result.run, body: result.body };
}

async function runTurn(deps: RunAgentTurnDeps, input: RunAgentTurnInput, delivery: Delivery): Promise<TurnResult> {
  const hopCount = input.hopCount ?? 0;
  if (hopCount > DEFAULT_MAX_HOP_COUNT) {
    throw new MaxHopCountExceededError(
      `hopCount ${hopCount} exceeds DEFAULT_MAX_HOP_COUNT (${DEFAULT_MAX_HOP_COUNT})`
    );
  }

  const runId = randomUUID();
  const rootRunId = input.rootRunId ?? runId;
  const causationId = input.causationId ?? null;
  const topic = `conversation:${input.conversationId}`;

  const queue = causationId === null ? deps.queue : undefined;
  const waits = queue?.isBusy(input.agentId) ?? false;
  createAgentRun(deps.db, {
    runId,
    rootRunId,
    causationId,
    hopCount,
    agentId: input.agentId,
    conversationId: input.conversationId,
    status: waits ? 'queued' : 'running',
    trigger: input.trigger ?? 'message',
    triggerMessageId: input.triggerMessageId ?? null,
  });
  const trace = (type: string, data: Record<string, unknown> = {}) => appendRunEvent(deps.db, runId, type, data);
  const changed = () => deps.onAgentChange?.(input.agentId);

  let release: (() => void) | undefined;
  if (queue) {
    if (waits) {
      trace('run.queued', { agentId: input.agentId });
      changed();
    }
    release = await queue.enter(input.agentId);
    if (waits && !startAgentRun(deps.db, runId)) {
      // Cancelled while it waited: nothing ran, so there is nothing to post.
      release();
      changed();
      const cancelled = new RunCancelledError('the run was cancelled before it started');
      failedRuns.set(cancelled, runId);
      throw cancelled;
    }
  }
  try {
    return await executeTurn(deps, input, delivery, { runId, rootRunId, causationId, hopCount, topic, trace, changed });
  } finally {
    release?.();
    changed();
  }
}

interface TurnContext {
  runId: string;
  rootRunId: string;
  causationId: string | null;
  hopCount: number;
  topic: string;
  trace: (type: string, data?: Record<string, unknown>) => unknown;
  changed: () => void;
}

const agentName = (db: Database, agentId: string): string =>
  (db.prepare('SELECT name FROM agents WHERE id = ?').pluck().get(agentId) as string | undefined) ?? 'An agent';

async function executeTurn(
  deps: RunAgentTurnDeps,
  input: RunAgentTurnInput,
  delivery: Delivery,
  { runId, rootRunId, causationId, hopCount, topic, trace, changed }: TurnContext,
): Promise<TurnResult> {
  trace('run.started', { agentId: input.agentId, trigger: input.trigger ?? 'message', hopCount, causationId });
  if (input.routingDecision) trace('routing.decision', input.routingDecision);
  deps.hub.publish(topic, 'agent.run.started', {
    runId, rootRunId, causationId, agentId: input.agentId, conversationId: input.conversationId,
  });
  changed();

  const finish = (status: 'completed' | 'failed' | 'cancelled', extra: Record<string, unknown> = {}) =>
    deps.hub.publish(topic, 'agent.run.finished', {
      runId, rootRunId, agentId: input.agentId, conversationId: input.conversationId, status, ...extra,
    });

  let result: AgentTurnResult;
  try {
    // A delegated run sees the task it was given and nothing else of the
    // conversation: what it may know is what the delegating agent chose to say.
    const recentMessages: Message[] = delivery.kind === 'return'
      ? [{
          id: `task:${runId}`,
          conversationId: input.conversationId,
          authorId: delivery.task.fromAgentId,
          authorType: 'agent',
          body: delivery.task.text,
          mentions: [],
          replyToMessageId: null,
          attachments: [],
          createdAt: new Date().toISOString(),
        }]
      : listRecentMessagesForConversation(deps.db, input.conversationId, 20);
    result = await deps.respond({
      agentId: input.agentId,
      conversationId: input.conversationId,
      recentMessages,
      run: { runId, rootRunId, hopCount },
      allowArtifacts: delivery.kind === 'post',
      onEvent: ({ type, ...data }) => trace(type, data),
      isCancelled: () => isRunCancelled(deps.db, runId),
    });
    if (isRunCancelled(deps.db, runId)) throw new RunCancelledError('the run was cancelled before it answered');
  } catch (error) {
    const failure = failureOf(error);
    if (error instanceof RunCancelledError) {
      trace('run.cancelled', failure);
      finish('cancelled');
    } else {
      failAgentRun(deps.db, runId, failure);
      trace('run.failed', failure);
      finish('failed', { errorCode: failure.code });
      void emitNotification(deps.db, {
        type: 'agent.needs_attention',
        recipients: conversationPeople(deps.db, input.conversationId),
        dedupeKey: `run-failed:${runId}`,
        collapseKey: `conversation:${input.conversationId}`,
        title: `${agentName(deps.db, input.agentId)} could not finish`,
        body: failure.message,
        conversationId: input.conversationId,
      });
    }
    if (typeof error === 'object' && error !== null) failedRuns.set(error, runId);
    throw error;
  }

  if (delivery.kind === 'return') {
    completeAgentRun(deps.db, runId, null);
    trace('run.completed', { deliveredTo: 'delegating_agent' });
    finish('completed');
    return {
      run: getAgentRun(deps.db, runId)!,
      message: null,
      body: result.body,
      handoff: { attempted: false, dispatched: false },
    };
  }

  const message = createMessage(deps.db, {
    conversationId: input.conversationId,
    authorId: input.agentId,
    authorType: 'agent',
    body: result.body,
    mentions: [],
    replyToMessageId: null,
    attachmentIds: result.artifactIds ?? [],
    attachmentOwnerId: deps.db.prepare('SELECT owner_user_id FROM agents WHERE id = ?').pluck().get(input.agentId) as string | undefined,
  });
  completeAgentRun(deps.db, runId, message.id);
  trace('run.completed', { resultMessageId: message.id });
  deps.hub.publish(topic, 'message.created', { ...message });
  finish('completed', { resultMessageId: message.id });
  void emitNotification(deps.db, {
    type: 'agent.completed',
    recipients: conversationPeople(deps.db, input.conversationId),
    dedupeKey: `run-completed:${runId}`,
    collapseKey: `conversation:${input.conversationId}`,
    title: `${agentName(deps.db, input.agentId)} replied`,
    body: result.body.length > 280 ? `${result.body.slice(0, 277)}...` : result.body,
    conversationId: input.conversationId,
  });
  enqueueJob(deps.db, {
    type: SUMMARIZE_CONVERSATION_JOB_TYPE,
    payload: { conversationId: input.conversationId },
    dedupeKey: `${SUMMARIZE_CONVERSATION_JOB_TYPE}:${input.conversationId}`,
  });
  const run = getAgentRun(deps.db, runId)!;

  if (!result.handoffToAgentId) {
    return { run, message, body: result.body, handoff: { attempted: false, dispatched: false } };
  }

  const nextHopCount = hopCount + 1;
  if (nextHopCount > DEFAULT_MAX_HOP_COUNT) {
    return { run, message, body: result.body, handoff: { attempted: true, dispatched: false, blockedReason: 'max_hop_count_exceeded' } };
  }

  const nested = await runAgentTurn(deps, {
    agentId: result.handoffToAgentId,
    conversationId: input.conversationId,
    rootRunId,
    causationId: runId,
    hopCount: nextHopCount,
    trigger: 'handoff',
  });

  return {
    run,
    message,
    body: result.body,
    handoff: { attempted: true, dispatched: true, blockedReason: nested.handoff.blockedReason },
  };
}
