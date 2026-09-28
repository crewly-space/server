import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret, encryptDatabaseSecret } from '../db/secrets.js';
import type { Agent } from '../protocol/index.js';
import type { AgentToolset, ToolOutcome, ToolsetProvider } from '../providers/respond.js';
import type { McpClientOptions } from '../mcp/client.js';
import { getMcpServer } from '../mcp/repository.js';
import { callMcpServerTool, explainMcpError } from '../mcp/service.js';
import { recordToolExecution } from './audit.js';
import { buildToolCatalog, toolsForAgent, type CatalogEntry } from './catalog.js';
import { callRisk } from './classify.js';
import { evaluateToolPolicy, hasStandingApproval, rememberApproval, setToolPolicy, type PolicyDecision } from './policy.js';
import { checkArguments, redactArguments } from './schema.js';
import { searchTools } from './search.js';
import type { ToolPolicyMode } from './types.js';

/**
 * The tool runtime. Every call an agent makes to an external tool comes
 * through here, whether a native connector or an MCP server supplies it:
 *
 *   granted? -> arguments valid? -> this call's risk -> policy
 *     -> (approval) -> credential resolved here, never by the model
 *     -> execute -> audit -> connection health
 *
 * The model sees tool names, schemas and results. It never sees a token.
 */

export interface ToolRuntimeOptions {
  mcp: McpClientOptions;
  fetchImpl: typeof fetch;
  /** Above this many tools an agent gets `search_tools` instead of every schema. */
  searchThreshold?: number;
}

const DEFAULT_SEARCH_THRESHOLD = 24;
const SEARCH_TOOL = 'search_tools';
const MAX_RESULT_CHARS = 50_000;
const TOOL_APPROVAL_TTL_MS = 24 * 60 * 60_000;

export interface ToolCallContext {
  agent: Pick<Agent, 'id' | 'ownerUserId'>;
  runId?: string;
  conversationId?: string;
  /** Who is responsible for this execution: the agent's owner, or whoever approved it. */
  userId?: string | null;
  approvalId?: string | null;
  /** Set when a person already approved this exact call. */
  preApproved?: boolean;
}

export type ToolCallResult =
  | { status: 'success'; content: string; isError: boolean }
  | { status: 'error'; content: string }
  | { status: 'blocked'; content: string; decision: PolicyDecision }
  | { status: 'approval_required'; content: string; approvalId: string; decision: PolicyDecision };

function auditBase(tool: CatalogEntry & { skillId?: string | null }, context: ToolCallContext) {
  return {
    agentId: context.agent.id, userId: context.userId ?? context.agent.ownerUserId ?? null, runId: context.runId ?? null,
    conversationId: context.conversationId ?? null, skillId: tool.skillId ?? null, connectionKind: tool.source.kind,
    connectionId: tool.source.connectionId, provider: tool.provider, toolRef: tool.ref, toolName: tool.source.toolName,
  };
}

/** Runs the tool itself. Only called once policy has said yes. */
async function invoke(db: Database, tool: CatalogEntry, agentId: string, input: Record<string, unknown>, options: ToolRuntimeOptions)
  : Promise<{ content: string; isError: boolean; secrets: string[] }> {
  if (tool.source.kind === 'connector') {
    const result = await tool.native!.execute({ db, connectionId: tool.source.connectionId, agentId, fetch: options.fetchImpl }, input);
    return { content: JSON.stringify(result), isError: false, secrets: [] };
  }
  const server = getMcpServer(db, tool.source.connectionId);
  if (!server?.enabled) throw new Error(`${tool.source.connectionName} is disabled`);
  const result = await callMcpServerTool(db, server, tool.source.toolName, input, { ...options.mcp, idempotent: tool.risk === 'read' });
  return { content: result.text || '(no output)', isError: result.isError, secrets: result.secrets };
}

function queueApproval(db: Database, tool: CatalogEntry, input: Record<string, unknown>, context: ToolCallContext & { runId: string }, decision: PolicyDecision, effective: { risk: string; permission: string }): string {
  const hash = createHash('sha256').update(`${tool.source.connectionId}:${tool.source.toolName}:${JSON.stringify(input)}`).digest('hex');
  const existing = db.prepare(`SELECT id FROM approvals WHERE run_id = ? AND action_hash = ? AND status = 'pending'`).pluck().get(context.runId, hash) as string | undefined;
  if (existing) return existing;
  const id = randomUUID();
  const now = new Date();
  const details = {
    kind: 'tool',
    tool: tool.ref,
    toolName: tool.source.toolName,
    title: `${tool.name.replaceAll('_', ' ')} on ${tool.source.connectionName}`,
    connection: { kind: tool.source.kind, id: tool.source.connectionId, name: tool.source.connectionName, trust: tool.source.trust },
    provider: tool.provider,
    risk: effective.risk,
    permission: effective.permission,
    mode: decision.mode,
    reason: decision.reason,
    // Enough to decide on, never a credential: the same redaction the audit log uses.
    arguments: redactArguments(input),
    conversationId: context.conversationId ?? null,
  };
  db.prepare(`INSERT INTO approvals (id, run_id, agent_id, action, details, status, created_at, resolved_at, capability, action_hash, expires_at, tool_call)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?, ?)`).run(
    id, context.runId, context.agent.id, tool.ref, JSON.stringify(details), now.toISOString(), `tool.${effective.risk}`, hash,
    new Date(now.getTime() + TOOL_APPROVAL_TTL_MS).toISOString(),
    encryptDatabaseSecret(db, JSON.stringify({ connectionId: tool.source.connectionId, toolName: tool.source.toolName, input, conversationId: context.conversationId ?? null, mode: decision.mode })),
  );
  return id;
}

/**
 * One call, start to finish. Returns what the model should read, and records
 * the outcome whatever it was.
 */
export async function executeToolCall(
  db: Database,
  tool: CatalogEntry & { skillId?: string | null },
  input: Record<string, unknown>,
  context: ToolCallContext,
  options: ToolRuntimeOptions,
): Promise<ToolCallResult> {
  const started = Date.now();
  const base = auditBase(tool, context);
  const invalid = checkArguments(tool.inputSchema, input);
  const effective = callRisk(tool, input);
  if (invalid) {
    recordToolExecution(db, { ...base, risk: effective.risk, permission: effective.permission, arguments: input, status: 'error', policyMode: null,
      approvalId: context.approvalId ?? null, resultMeta: {}, durationMs: 0, error: `invalid arguments: ${invalid}` });
    return { status: 'error', content: `Invalid arguments for ${tool.modelName}: ${invalid}` };
  }

  const decision = evaluateToolPolicy(db, context.agent.id, { ...tool, ...effective });
  const audit = (status: 'success' | 'error' | 'blocked' | 'approval_required', extra: { approvalId?: string | null; error?: string | null; resultMeta?: Record<string, unknown>; secrets?: string[] } = {}) =>
    recordToolExecution(db, { ...base, risk: effective.risk, permission: effective.permission, arguments: input, status, policyMode: decision.mode,
      approvalId: extra.approvalId ?? context.approvalId ?? null, resultMeta: extra.resultMeta ?? {}, durationMs: Date.now() - started,
      error: extra.error ?? null, knownSecrets: extra.secrets });

  if (decision.mode === 'blocked') {
    audit('blocked', { error: decision.reason });
    return { status: 'blocked', content: `${tool.modelName} is blocked: ${decision.reason}. Do not try to work around this; tell the person what you needed it for.`, decision };
  }
  const needsApproval = !context.preApproved && (decision.mode === 'ask_every_time'
    || (decision.mode === 'ask_once' && !hasStandingApproval(db, context.agent.id, tool.ref)));
  if (needsApproval) {
    if (!context.runId) {
      audit('blocked', { error: 'approval required outside a run' });
      return { status: 'blocked', content: `${tool.modelName} needs a person's approval, which can only be asked for during a run.`, decision };
    }
    const approvalId = queueApproval(db, tool, input, { ...context, runId: context.runId }, decision, effective);
    audit('approval_required', { approvalId });
    return {
      status: 'approval_required', approvalId, decision,
      content: `Approval requested for ${tool.modelName} (${decision.reason}). Crewly will run exactly this call once a person approves it and post the result here. Do not call it again; continue with anything that does not depend on it, or tell the person you are waiting.`,
    };
  }

  try {
    const result = await invoke(db, tool, context.agent.id, input, options);
    audit(result.isError ? 'error' : 'success', { resultMeta: { bytes: result.content.length, isError: result.isError }, secrets: result.secrets,
      error: result.isError ? result.content.slice(0, 300) : null });
    return { status: 'success', content: result.content.slice(0, MAX_RESULT_CHARS), isError: result.isError };
  } catch (error) {
    const failure = tool.source.kind === 'mcp_server' ? explainMcpError(error) : { code: 'connector_failed', message: error instanceof Error ? error.message : String(error) };
    audit('error', { error: failure.message, secrets: (error as { secrets?: string[] }).secrets });
    return { status: 'error', content: `${tool.modelName} failed: ${redactArguments(failure.message, (error as { secrets?: string[] }).secrets ?? [])}` };
  }
}

/**
 * The tools an agent may use this turn, as the model sees them. A blocked
 * tool is not offered at all. With many tools only `search_tools` is offered
 * at first, and each search adds what it found for the rest of the turn.
 */
export function toolRuntimeToolset(db: Database, options: ToolRuntimeOptions): ToolsetProvider {
  return (agent, input): AgentToolset | undefined => {
    const granted = toolsForAgent(db, agent.id)
      .filter((tool) => !tool.schemaIssues)
      .filter((tool) => evaluateToolPolicy(db, agent.id, tool).mode !== 'blocked');
    if (!granted.length) return undefined;
    const byModelName = new Map(granted.map((tool) => [tool.modelName, tool]));
    const threshold = options.searchThreshold ?? DEFAULT_SEARCH_THRESHOLD;
    const lazy = granted.length > threshold;
    const active = new Set<string>(lazy ? [] : granted.map((tool) => tool.modelName));
    const definition = (tool: CatalogEntry) => ({
      name: tool.modelName,
      description: `${tool.description} [${tool.source.connectionName}; ${tool.risk.replace('_', ' ')}]`.slice(0, 1024),
      inputSchema: tool.inputSchema,
    });
    const searchDefinition = {
      name: SEARCH_TOOL,
      description: `Find tools by what you want to do, e.g. "sentry search errors" or "cloudflare update DNS record". You have ${granted.length} tools from ${new Set(granted.map((tool) => tool.source.connectionName)).size} connections; the ones found become callable for the rest of this turn.`,
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What you want to do, in a few words' } }, required: ['query'], additionalProperties: false },
    };

    return {
      get definitions() {
        return [...(lazy ? [searchDefinition] : []), ...[...active].map((name) => definition(byModelName.get(name)!))];
      },
      instructions: lazy
        ? `You have access to ${granted.length} external tools. They are not all listed: call ${SEARCH_TOOL} with what you want to do to find the right ones, then call them. Credentials are handled by Crewly; never ask for or include tokens or keys.`
        : 'External tools run through Crewly with the connection\'s own credentials; never ask for or include tokens or keys. Some actions need a person\'s approval: when a tool says approval was requested, do not retry it.',
      async execute(call): Promise<ToolOutcome> {
        if (call.name === SEARCH_TOOL && lazy) {
          const query = typeof call.input.query === 'string' ? call.input.query : '';
          const hits = searchTools(granted, query, 8);
          for (const hit of hits) active.add(hit.tool.modelName);
          if (!hits.length) return { content: `No tools match "${query}". Try other words, or say what you need.` };
          return { content: JSON.stringify(hits.map(({ tool }) => ({ name: tool.modelName, description: tool.description.slice(0, 200), risk: tool.risk, connection: tool.source.connectionName }))) };
        }
        const tool = byModelName.get(call.name);
        if (!tool) return { content: `There is no tool called ${call.name}.`, isError: true };
        active.add(tool.modelName);
        const result = await executeToolCall(db, tool, call.input as Record<string, unknown>, {
          agent, runId: input.run?.runId, conversationId: input.conversationId,
        }, options);
        return { content: result.content, isError: result.status !== 'success' || result.isError };
      },
    };
  };
}

export interface ApprovedExecution {
  status: 'success' | 'error' | 'blocked' | 'skipped';
  toolRef: string | null;
  content: string;
  conversationId: string | null;
}

/**
 * Runs the exact call a person just approved. The grant is checked again --
 * an approval does not outlive the agent's access -- and a block that was
 * added since wins; approval itself is not asked for twice.
 */
export async function executeApprovedToolCall(
  db: Database,
  approvalId: string,
  input: { userId: string; remember?: boolean },
  options: ToolRuntimeOptions,
): Promise<ApprovedExecution> {
  const row = db.prepare('SELECT agent_id, run_id, tool_call, execution FROM approvals WHERE id = ?').get(approvalId) as
    { agent_id: string; run_id: string; tool_call: string | null; execution: string | null } | undefined;
  if (!row?.tool_call) return { status: 'skipped', toolRef: null, content: '', conversationId: null };
  if (row.execution) return { ...(JSON.parse(row.execution) as ApprovedExecution), status: 'skipped' };
  const call = JSON.parse(decryptDatabaseSecret(db, row.tool_call)) as { connectionId: string; toolName: string; input: Record<string, unknown>; conversationId: string | null; mode: ToolPolicyMode };
  const agent = db.prepare('SELECT id, owner_user_id FROM agents WHERE id = ?').get(row.agent_id) as { id: string; owner_user_id: string } | undefined;
  const finish = (result: ApprovedExecution): ApprovedExecution => {
    // The execution record keeps what happened, not what the tool returned.
    db.prepare('UPDATE approvals SET execution = ? WHERE id = ?').run(JSON.stringify({ ...result, content: result.content.slice(0, 500) }), approvalId);
    return result;
  };
  if (!agent) return finish({ status: 'blocked', toolRef: null, content: 'The agent no longer exists.', conversationId: call.conversationId });
  const tool = toolsForAgent(db, agent.id, buildToolCatalog(db)).find((entry) => entry.source.connectionId === call.connectionId && entry.source.toolName === call.toolName);
  if (!tool) return finish({ status: 'blocked', toolRef: null, content: 'The agent no longer has this tool, so the approved action was not run.', conversationId: call.conversationId });

  if (call.mode === 'ask_once') rememberApproval(db, { agentId: agent.id, toolRef: tool.ref, approvalId, userId: input.userId });
  if (input.remember) {
    // "Always allow" is recorded as this agent's rule for this tool; floors still apply.
    setToolPolicy(db, { agentId: agent.id, selectorType: 'tool', selector: tool.ref, mode: 'always', userId: input.userId });
  }
  const result = await executeToolCall(db, tool, call.input, {
    agent: { id: agent.id, ownerUserId: agent.owner_user_id }, runId: row.run_id, conversationId: call.conversationId ?? undefined,
    userId: input.userId, approvalId, preApproved: true,
  }, options);
  return finish({
    status: result.status === 'success' ? (result.isError ? 'error' : 'success') : result.status === 'blocked' ? 'blocked' : 'error',
    toolRef: tool.ref,
    content: result.content,
    conversationId: call.conversationId,
  });
}
