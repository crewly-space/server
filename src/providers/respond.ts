import { AGENTD_BACKED_PROVIDER_KINDS, type ChatMessage, type Message, type ProviderKind, type ToolCall, type ToolDefinition } from '../protocol/index.js';
import type { Agent } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { getAgent } from '../agents/repository.js';
import { listMemoryFactsForAgent } from '../memory/repository.js';
import { getConversationSummary } from '../memory/summary-repository.js';
import { RunCancelledError, type RespondFn, type RespondInput, type TurnEvent } from '../runtime/engine.js';
import { AiGateway } from '../gateway/gateway.js';
import { ProviderError } from './errors.js';
import type { DeviceConnectionHub } from '../devices/hub.js';
import { getProviderConfig } from './repository.js';
import { capabilityInstructions } from './capabilities.js';

/**
 * Whether the provider this agent answers with can be handed tool
 * definitions. Device-backed providers cannot: the gateway strips tools for
 * them, so offering tools -- or describing them -- would promise the model
 * something that never reaches it.
 */
function acceptsTools(db: Database, providerId: string): boolean {
  const config = getProviderConfig(db, providerId);
  return !config || !(AGENTD_BACKED_PROVIDER_KINDS as readonly ProviderKind[]).includes(config.kind);
}

function toChatMessages(agentId: string, recentMessages: Message[]): ChatMessage[] {
  return recentMessages.map((m) => ({
    role: m.authorType === 'agent' && m.authorId === agentId ? 'assistant' : 'user',
    content: m.body,
  }));
}

/** What a tool call produced, as the model will read it. */
export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

/** The tools one agent may use on one turn, and how to run them. */
export interface AgentToolset {
  definitions: ToolDefinition[];
  execute(call: ToolCall): Promise<ToolOutcome>;
  /** Extra system text that explains the tools, if they need it. */
  instructions?: string;
}

/**
 * Supplies tools for a turn. Several can be registered -- MCP servers and
 * delegation each contribute their own -- and their toolsets are merged.
 */
export type ToolsetProvider = (agent: Agent, input: RespondInput) => AgentToolset | undefined | Promise<AgentToolset | undefined>;

/** Contributes system-prompt text for a turn, such as the skills assigned to the agent. */
export type InstructionProvider = (agent: Agent, input: RespondInput) => string | undefined;

/** A model that keeps calling tools gets this many rounds before it must answer. */
export const MAX_TOOL_ROUNDS = 8;

export interface ProviderRespondOptions {
  gateway?: AiGateway;
  toolsets?: ToolsetProvider[];
  instructions?: InstructionProvider[];
}

function mergeToolsets(toolsets: AgentToolset[]): AgentToolset | undefined {
  if (toolsets.length === 0) return undefined;
  const owners = new Map<string, AgentToolset>();
  const definitions: ToolDefinition[] = [];
  for (const toolset of toolsets) {
    for (const definition of toolset.definitions) {
      // First provider to claim a name keeps it; a model cannot be offered two
      // tools with one name and be expected to mean the right one.
      if (owners.has(definition.name)) continue;
      owners.set(definition.name, toolset);
      definitions.push(definition);
    }
  }
  return {
    definitions,
    instructions: toolsets.map((t) => t.instructions).filter(Boolean).join('\n\n') || undefined,
    async execute(call) {
      const owner = owners.get(call.name);
      if (!owner) return { content: `There is no tool called "${call.name}".`, isError: true };
      return owner.execute(call);
    },
  };
}

export function createProviderRespond(
  db: Database,
  fetchImpl: typeof fetch = fetch,
  deviceHub?: DeviceConnectionHub,
  options: ProviderRespondOptions = {},
): RespondFn {
  const gateway = options.gateway ?? new AiGateway({ db, fetchImpl, deviceHub });
  const toolsetProviders = options.toolsets ?? [];
  const instructionProviders = options.instructions ?? [];

  return async (input) => {
    const { agentId, conversationId, recentMessages } = input;
    const agent = getAgent(db, agentId);
    if (!agent) {
      throw new ProviderError(`agent ${agentId} not found`);
    }

    const toolsets = acceptsTools(db, agent.modelPolicy.defaultProviderId)
      ? (await Promise.all(toolsetProviders.map((provide) => provide(agent, input))))
        .filter((toolset): toolset is AgentToolset => Boolean(toolset?.definitions.length))
      : [];
    const tools = mergeToolsets(toolsets);

    const facts = listMemoryFactsForAgent(db, agentId).slice(-20);
    const summary = getConversationSummary(db, conversationId);
    const context = [agent.personality && `Agent instructions: ${agent.personality}`,
      ...instructionProviders.map((provide) => provide(agent, input)),
      tools?.instructions,
      // Always last among the instructions: whatever the agent's own
      // personality says it can do, this is what it can do on this run.
      capabilityInstructions(tools?.definitions ?? []),
      facts.length && `Memory facts:\n${facts.map((f) => `- ${f.content}`).join('\n')}`,
      summary && `Conversation summary: ${summary.summary}`].filter(Boolean).join('\n\n');
    const messages: ChatMessage[] = context
      ? [{ role: 'system', content: context }, ...toChatMessages(agentId, recentMessages)]
      : toChatMessages(agentId, recentMessages);

    const policy = agent.modelPolicy;
    const fallback = policy.fallbackProviderId && policy.fallbackModel
      ? { providerId: policy.fallbackProviderId, model: policy.fallbackModel }
      : undefined;
    const onEvent = (event: TurnEvent) => input.onEvent?.(event);

    const stopIfCancelled = () => {
      if (input.isCancelled?.()) throw new RunCancelledError('the run was cancelled');
    };

    for (let round = 0; ; round += 1) {
      stopIfCancelled();
      // On the last round the tools are withheld, so the model has to answer
      // with what it has instead of asking for one more thing.
      const offerTools = tools && round < MAX_TOOL_ROUNDS ? tools.definitions : undefined;
      // Failures surface as an `agent.run.failed` event, not as a message the
      // agent appears to have spoken. Callers translate them for the UI.
      const response = await gateway.chat({
        target: { providerId: policy.defaultProviderId, model: policy.defaultModel },
        fallback,
        messages,
        tools: offerTools,
        context: {
          purpose: 'agent_turn',
          ownerUserId: agent.ownerUserId,
          agentId,
          conversationId,
          runId: input.run?.runId,
          rootRunId: input.run?.rootRunId,
          onEvent,
        },
      });

      if (!tools || !offerTools || !response.toolCalls?.length) {
        return { body: response.content };
      }

      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
      for (const call of response.toolCalls) {
        stopIfCancelled();
        const started = Date.now();
        let outcome: ToolOutcome;
        try {
          outcome = await tools.execute(call);
        } catch (error) {
          outcome = { content: `The tool failed: ${(error as Error).message}`, isError: true };
        }
        onEvent({
          type: 'tool.call',
          toolCallId: call.id,
          name: call.name,
          status: outcome.isError ? 'error' : 'ok',
          durationMs: Date.now() - started,
          // Sizes, not contents: inputs and results can carry anything the
          // tool touched, and the trace is readable by more people than that.
          inputBytes: JSON.stringify(call.input).length,
          outputBytes: outcome.content.length,
        });
        messages.push({ role: 'tool', toolCallId: call.id, content: outcome.content, isError: outcome.isError });
      }
    }
  };
}
