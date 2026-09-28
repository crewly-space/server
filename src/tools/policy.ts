import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { evaluateCapability, type ExecutionCapability } from '../permissions/capabilities.js';
import { getProviderProfile } from './providers.js';
import { stricterMode, type NormalizedTool, type ToolPolicyMode, type ToolRisk } from './types.js';

/**
 * The permissions engine for tools. Being *given* a tool (a grant) decides
 * whether an agent sees it at all; a policy decides what happens when it
 * calls it: run it, ask a person once, ask every time, or refuse.
 *
 * Resolution, most specific first: this agent's rule for the exact tool, its
 * permission, its connection, its risk class; then the same four at
 * workspace level; then the default for the tool's risk. Two things cannot
 * be relaxed by any rule: a workspace `blocked` is a ceiling for every agent,
 * and financial, dangerous or destructive calls always ask at least every time.
 */

export type SelectorType = 'tool' | 'permission' | 'risk' | 'connection';
export const SELECTOR_TYPES: readonly SelectorType[] = ['tool', 'permission', 'connection', 'risk'];

export interface ToolPolicy {
  id: string;
  agentId: string | null;
  selectorType: SelectorType;
  selector: string;
  mode: ToolPolicyMode;
  sourceSkillId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PolicyRow {
  id: string; agent_id: string | null; selector_type: SelectorType; selector: string; mode: ToolPolicyMode;
  source_skill_id: string | null; created_at: string; updated_at: string;
}

const view = (row: PolicyRow): ToolPolicy => ({
  id: row.id, agentId: row.agent_id, selectorType: row.selector_type, selector: row.selector, mode: row.mode,
  sourceSkillId: row.source_skill_id, createdAt: row.created_at, updatedAt: row.updated_at,
});

export function listToolPolicies(db: Database, agentId?: string | null): ToolPolicy[] {
  const rows = agentId === undefined
    ? db.prepare('SELECT * FROM tool_policies ORDER BY agent_id IS NOT NULL, selector_type, selector').all()
    : agentId === null
      ? db.prepare('SELECT * FROM tool_policies WHERE agent_id IS NULL ORDER BY selector_type, selector').all()
      : db.prepare('SELECT * FROM tool_policies WHERE agent_id = ? ORDER BY selector_type, selector').all(agentId);
  return (rows as PolicyRow[]).map(view);
}

export function setToolPolicy(db: Database, input: {
  agentId: string | null; selectorType: SelectorType; selector: string; mode: ToolPolicyMode; sourceSkillId?: string | null; userId: string | null;
}): ToolPolicy {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM tool_policies WHERE COALESCE(agent_id, \'\') = ? AND selector_type = ? AND selector = ?')
    .pluck().get(input.agentId ?? '', input.selectorType, input.selector) as string | undefined;
  if (existing) {
    db.prepare('UPDATE tool_policies SET mode = ?, source_skill_id = ?, updated_at = ? WHERE id = ?')
      .run(input.mode, input.sourceSkillId ?? null, now, existing);
    return view(db.prepare('SELECT * FROM tool_policies WHERE id = ?').get(existing) as PolicyRow);
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO tool_policies (id, agent_id, selector_type, selector, mode, source_skill_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.agentId, input.selectorType, input.selector, input.mode, input.sourceSkillId ?? null, input.userId, now, now);
  return view(db.prepare('SELECT * FROM tool_policies WHERE id = ?').get(id) as PolicyRow);
}

export function deleteToolPolicy(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM tool_policies WHERE id = ?').run(id).changes > 0;
}

/** Replaces one agent's (or the workspace's) rules in one go. */
export function replaceToolPolicies(db: Database, agentId: string | null, policies: Array<{ selectorType: SelectorType; selector: string; mode: ToolPolicyMode }>, userId: string): ToolPolicy[] {
  db.transaction(() => {
    if (agentId) db.prepare('DELETE FROM tool_policies WHERE agent_id = ?').run(agentId);
    else db.prepare('DELETE FROM tool_policies WHERE agent_id IS NULL').run();
    for (const policy of policies) setToolPolicy(db, { agentId, ...policy, userId });
  })();
  return listToolPolicies(db, agentId);
}

const RISK_DEFAULTS: Record<ToolRisk, ToolPolicyMode> = {
  read: 'always',
  write: 'ask_once',
  external_message: 'ask_every_time',
  delete: 'ask_every_time',
  execute: 'ask_every_time',
  deploy: 'ask_every_time',
  financial: 'ask_every_time',
  admin: 'blocked',
  dangerous: 'blocked',
};

/** Calls that can never run without a person saying yes, whatever a rule says. */
function floorFor(tool: Pick<NormalizedTool, 'risk' | 'permission'>): ToolPolicyMode {
  if (tool.risk === 'financial' || tool.risk === 'dangerous' || tool.permission === 'destructive:execute') return 'ask_every_time';
  return 'always';
}

type PolicyTarget = Pick<NormalizedTool, 'ref' | 'risk' | 'permission' | 'provider'> & { source: Pick<NormalizedTool['source'], 'connectionId' | 'trust'> };

export function defaultToolMode(tool: PolicyTarget): ToolPolicyMode {
  // A destructive statement asks rather than being refused outright: the tool itself is allowed, this call is not routine.
  if (tool.permission === 'destructive:execute') return 'ask_every_time';
  const providerDefault = getProviderProfile(tool.provider)?.defaultModes?.[tool.permission];
  let mode = providerDefault ?? RISK_DEFAULTS[tool.risk];
  // Reads from a server nobody has vouched for still get looked at once.
  if (tool.risk === 'read' && (tool.source.trust === 'unverified' || tool.source.trust === 'community')) mode = stricterMode(mode, 'ask_once');
  return mode;
}

export interface PolicyDecision {
  mode: ToolPolicyMode;
  /** Where the decision came from, in words a person can act on. */
  reason: string;
  policyId: string | null;
}

function selectorValue(tool: PolicyTarget, type: SelectorType): string {
  return type === 'tool' ? tool.ref : type === 'permission' ? tool.permission : type === 'risk' ? tool.risk : tool.source.connectionId;
}

/** Execution capabilities a tool call exercises, for rules written before tools had their own policies. */
function executionCapabilities(tool: PolicyTarget & { serverCapabilities?: string[] }): ExecutionCapability[] {
  const capabilities: ExecutionCapability[] = ['network.access'];
  if (tool.risk !== 'read') capabilities.push('external.side_effect');
  for (const capability of tool.serverCapabilities ?? []) {
    if (capability === 'shell') capabilities.push('process.execute');
    if (capability === 'filesystem') capabilities.push('filesystem.read', 'filesystem.write');
  }
  return capabilities;
}

export function evaluateToolPolicy(db: Database, agentId: string, tool: PolicyTarget & { serverCapabilities?: string[] }): PolicyDecision {
  const rules = [...listToolPolicies(db, agentId), ...listToolPolicies(db, null)];
  const match = (agent: string | null) => SELECTOR_TYPES
    .map((type) => rules.find((rule) => rule.agentId === agent && rule.selectorType === type && rule.selector === selectorValue(tool, type)))
    .find(Boolean);
  const agentRule = match(agentId);
  const workspaceRule = match(null);
  let decision: PolicyDecision = agentRule
    ? { mode: agentRule.mode, reason: `this agent's rule for ${agentRule.selectorType} ${agentRule.selector}`, policyId: agentRule.id }
    : workspaceRule
      ? { mode: workspaceRule.mode, reason: `the workspace rule for ${workspaceRule.selectorType} ${workspaceRule.selector}`, policyId: workspaceRule.id }
      : { mode: defaultToolMode(tool), policyId: null,
        reason: tool.risk === 'read' && (tool.source.trust === 'unverified' || tool.source.trust === 'community')
          ? `tools from ${tool.source.trust} servers ask once before their first use`
          : `the default for ${tool.risk.replace('_', ' ')} tools` };

  // A workspace block applies to every agent, whatever the agent's own rule says.
  const workspaceBlock = SELECTOR_TYPES.map((type) => rules.find((rule) => rule.agentId === null && rule.mode === 'blocked'
    && rule.selectorType === type && rule.selector === selectorValue(tool, type))).find(Boolean);
  if (workspaceBlock) return { mode: 'blocked', reason: `blocked for the whole workspace (${workspaceBlock.selectorType} ${workspaceBlock.selector})`, policyId: workspaceBlock.id };

  const floor = floorFor(tool);
  if (stricterMode(decision.mode, floor) !== decision.mode) {
    decision = { mode: floor, reason: `${tool.risk === 'financial' ? 'money-moving' : 'destructive'} actions always need approval`, policyId: decision.policyId };
  }

  // Capability rules an admin set explicitly still hold: they were the policy before tools had one.
  for (const capability of executionCapabilities(tool)) {
    const explicit = evaluateCapability(db, { agentId, capability, scope: { connector: tool.source.connectionId, server: tool.source.connectionId } });
    if (!explicit.policyId) continue;
    if (explicit.decision === 'deny') return { mode: 'blocked', reason: `${capability} is denied by this agent's capability policy`, policyId: explicit.policyId };
    if (explicit.decision === 'ask' && stricterMode(decision.mode, 'ask_every_time') !== decision.mode) {
      decision = { mode: 'ask_every_time', reason: `${capability} asks under this agent's capability policy`, policyId: explicit.policyId };
    }
  }
  return decision;
}

/** "Ask once": whether a person already approved this agent using this tool. */
export function hasStandingApproval(db: Database, agentId: string, toolRef: string): boolean {
  return db.prepare('SELECT 1 FROM tool_approval_memory WHERE agent_id = ? AND tool_ref = ?').get(agentId, toolRef) !== undefined;
}

export function rememberApproval(db: Database, input: { agentId: string; toolRef: string; approvalId: string | null; userId: string | null }): void {
  db.prepare(`INSERT INTO tool_approval_memory (agent_id, tool_ref, approval_id, approved_by, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (agent_id, tool_ref) DO NOTHING`).run(input.agentId, input.toolRef, input.approvalId, input.userId, new Date().toISOString());
}

export function forgetApprovals(db: Database, agentId: string, toolRef?: string): void {
  if (toolRef) db.prepare('DELETE FROM tool_approval_memory WHERE agent_id = ? AND tool_ref = ?').run(agentId, toolRef);
  else db.prepare('DELETE FROM tool_approval_memory WHERE agent_id = ?').run(agentId);
}
