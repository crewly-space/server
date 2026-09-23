import type { Agent } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { getAgent } from '../agents/repository.js';
import { canAutoInvoke, type AgentStatusBroadcaster } from '../agents/status.js';
import { ProviderError } from '../providers/errors.js';
import type { AgentToolset, ToolsetProvider } from '../providers/respond.js';
import type { ConnectionHub } from '../ws/hub.js';
import { runDelegatedTurn, runIdOfFailure, RunCancelledError, type RespondFn } from './engine.js';
import type { AgentRunQueue } from './queue.js';
import { appendRunEvent, listAgentRunsForRoot } from './runs.js';
import { isAgentBlocked } from '../channels/repository.js';

export const DELEGATE_TOOL = 'delegate_to_agent';

/** How deep a chain of delegations may go by default. The run table allows at most 4 hops. */
export const DEFAULT_MAX_DELEGATION_DEPTH = 3;

export function listDelegates(db: Database, agentId: string): Agent[] {
  const ids = db
    .prepare('SELECT delegate_agent_id AS id FROM agent_delegates WHERE agent_id = ? ORDER BY created_at, delegate_agent_id')
    .pluck()
    .all(agentId) as string[];
  return ids.map((id) => getAgent(db, id)).filter((agent): agent is Agent => Boolean(agent));
}

export function setDelegates(db: Database, agentId: string, delegateIds: string[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM agent_delegates WHERE agent_id = ?').run(agentId);
    const insert = db.prepare('INSERT INTO agent_delegates (agent_id, delegate_agent_id, created_at) VALUES (?, ?, ?)');
    const now = new Date().toISOString();
    for (const id of new Set(delegateIds)) insert.run(agentId, id, now);
  })();
}

export interface DelegationOptions {
  db: Database;
  hub: ConnectionHub;
  /** Resolved late: the responder is built with this toolset in it. */
  respond: () => RespondFn;
  status: AgentStatusBroadcaster;
  queue?: AgentRunQueue;
  maxDepth?: number;
}

/** The agents already working on this chain, from the current run back to the root. */
function agentsInChain(db: Database, rootRunId: string, runId: string): Set<string> {
  const runs = new Map(listAgentRunsForRoot(db, rootRunId).map((run) => [run.runId, run]));
  const agents = new Set<string>();
  let cursor = runs.get(runId);
  while (cursor) {
    agents.add(cursor.agentId);
    cursor = cursor.causationId ? runs.get(cursor.causationId) : undefined;
  }
  return agents;
}

function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ProviderError || error instanceof RunCancelledError) return { code: error.code, message: error.message };
  return { code: 'agent_run_failed', message: error instanceof Error ? error.message : String(error) };
}

/**
 * The `delegate_to_agent` tool.
 *
 * Offered only to an agent that may message agents, has someone to delegate
 * to, and is not already at the depth limit. The delegate runs as a child of
 * the current run -- same root, the current run as its cause, one hop deeper
 * -- under its own tools, budgets and model, and sees only the task. Its
 * answer comes back as a structured tool result; the delegating agent decides
 * what to tell the conversation.
 */
export function delegationToolset(options: DelegationOptions): ToolsetProvider {
  const maxDepth = Math.min(options.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH, 4);
  const { db, hub } = options;

  return (agent, input): AgentToolset | undefined => {
    const run = input.run;
    if (!run || !agent.permissions.canMessageAgents) return undefined;
    if (run.hopCount + 1 > maxDepth) return undefined;
    const delegates = listDelegates(db, agent.id);
    if (delegates.length === 0) return undefined;

    const byName = new Map(delegates.map((delegate) => [delegate.name.toLowerCase(), delegate]));
    const byId = new Map(delegates.map((delegate) => [delegate.id, delegate]));
    const topic = `conversation:${input.conversationId}`;

    return {
      definitions: [{
        name: DELEGATE_TOOL,
        description:
          'Ask another agent to do a self-contained subtask and wait for its answer. The other agent sees only the task you write, not this conversation, so include everything it needs.',
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: delegates.map((delegate) => delegate.name), description: 'Who to ask.' },
            task: { type: 'string', description: 'The subtask, with all the context the other agent needs.' },
          },
          required: ['agent', 'task'],
        },
      }],
      instructions: [
        'You can hand subtasks to these agents with the delegate_to_agent tool:',
        ...delegates.map((delegate) => `- ${delegate.name}${delegate.personality ? `: ${delegate.personality.slice(0, 160)}` : ''}`),
      ].join('\n'),

      async execute(call) {
        const requested = String(call.input.agent ?? '');
        const task = String(call.input.task ?? '').trim();
        const target = byName.get(requested.toLowerCase()) ?? byId.get(requested);
        const refuse = (message: string) => ({ content: JSON.stringify({ status: 'refused', error: message }), isError: true });
        if (!target) return refuse(`You cannot delegate to "${requested}".`);
        if (!task) return refuse('The task is empty.');
        // A channel that keeps an agent out keeps it out of work done there too.
        if (isAgentBlocked(db, input.conversationId, target.id)) {
          return refuse(`${target.name} is blocked in this channel.`);
        }
        if (agentsInChain(db, run.rootRunId, run.runId).has(target.id)) {
          return refuse(`${target.name} is already working on this chain; delegating back would loop.`);
        }
        const status = options.status.status(target.id);
        if (status && !canAutoInvoke(status)) {
          return refuse(`${target.name} is unavailable (${status.presence}${status.reason ? `: ${status.reason}` : ''}).`);
        }

        appendRunEvent(db, run.runId, 'delegation.requested', { toAgentId: target.id, toAgentName: target.name, taskBytes: task.length });
        hub.publish(topic, 'agent.delegation', {
          parentRunId: run.runId, rootRunId: run.rootRunId, fromAgentId: agent.id, toAgentId: target.id, status: 'started',
        });
        try {
          const child = await runDelegatedTurn(
            {
              db,
              hub,
              respond: options.respond(),
              queue: options.queue,
              onAgentChange: (id) => options.status.refresh(id),
            },
            {
              agentId: target.id,
              conversationId: input.conversationId,
              rootRunId: run.rootRunId,
              causationId: run.runId,
              hopCount: run.hopCount + 1,
              task: { text: task, fromAgentId: agent.id },
            },
          );
          appendRunEvent(db, run.runId, 'delegation.completed', { toAgentId: target.id, childRunId: child.run.runId });
          hub.publish(topic, 'agent.delegation', {
            parentRunId: run.runId, rootRunId: run.rootRunId, childRunId: child.run.runId,
            fromAgentId: agent.id, toAgentId: target.id, status: 'completed',
          });
          return { content: JSON.stringify({ status: 'completed', agent: target.name, runId: child.run.runId, answer: child.body }) };
        } catch (error) {
          const failure = describeFailure(error);
          const childRunId = runIdOfFailure(error) ?? null;
          const outcome = error instanceof RunCancelledError ? 'cancelled' : 'failed';
          appendRunEvent(db, run.runId, `delegation.${outcome}`, { toAgentId: target.id, childRunId, code: failure.code });
          hub.publish(topic, 'agent.delegation', {
            parentRunId: run.runId, rootRunId: run.rootRunId, childRunId,
            fromAgentId: agent.id, toAgentId: target.id, status: outcome, errorCode: failure.code,
          });
          return {
            content: JSON.stringify({ status: outcome, agent: target.name, runId: childRunId, error: failure }),
            isError: true,
          };
        }
      },
    };
  };
}
