import type { Database } from '../db/driver.js';
import { buildToolCatalog, type CatalogEntry } from '../tools/catalog.js';
import { setToolPolicy } from '../tools/policy.js';
import { getProviderProfile, providersForArea } from '../tools/providers.js';
import type { ToolRisk } from '../tools/types.js';
import { upsertAgentSkill, type Skill, type SkillRequirement } from './skills.js';

/**
 * What installing a skill on an agent would mean, before anyone agrees to
 * it: which of its capabilities the workspace's connections can supply,
 * which exact tools each of its permissions maps to, and what is missing.
 * A skill never names a tool; it names permissions, and the connections that
 * are live decide which tools those are.
 */

export interface PlannedTool {
  ref: string;
  connectionId: string;
  connectionName: string;
  connectionKind: 'connector' | 'mcp_server';
  toolName: string;
  risk: ToolRisk;
  /** Local capabilities (shell, filesystem, network) an admin acknowledges by granting it. */
  serverCapabilities: string[];
}

export interface SkillPlan {
  skillId: string;
  requirements: Array<SkillRequirement & {
    required: boolean;
    /** Providers that could satisfy it, for "connect one of these". */
    candidates: Array<{ id: string; name: string }>;
    satisfiedBy: Array<{ connectionId: string; connectionName: string; provider: string }>;
  }>;
  permissions: Array<{ permission: string; approval: boolean; tools: PlannedTool[] }>;
  /** Every required capability has a live connection. */
  ready: boolean;
  missing: string[];
  /** Permissions nothing connected provides; the skill works without them, or does that part by hand. */
  unavailable: string[];
}

function planned(tool: CatalogEntry): PlannedTool {
  return {
    ref: tool.ref, connectionId: tool.source.connectionId, connectionName: tool.source.connectionName, connectionKind: tool.source.kind,
    toolName: tool.source.toolName, risk: tool.risk, serverCapabilities: tool.serverCapabilities ?? [],
  };
}

export function planSkill(db: Database, skill: Skill, catalog = buildToolCatalog(db)): SkillPlan {
  const withSchema = catalog.filter((tool) => !tool.schemaIssues);
  const accepts = (requirement: SkillRequirement, provider: string | null) => Boolean(provider)
    && (getProviderProfile(provider)?.areas.includes(requirement.capability) ?? false)
    && (requirement.oneOf.length === 0 || requirement.oneOf.includes(provider!));

  const requirements = [
    ...skill.requirements.requires.map((entry) => ({ ...entry, required: true })),
    ...skill.requirements.optional.map((entry) => ({ ...entry, required: false })),
  ].map((requirement) => {
    const connections = new Map<string, { connectionId: string; connectionName: string; provider: string }>();
    for (const tool of withSchema) {
      if (accepts(requirement, tool.provider)) connections.set(tool.source.connectionId, { connectionId: tool.source.connectionId, connectionName: tool.source.connectionName, provider: tool.provider! });
    }
    const candidateIds = requirement.oneOf.length ? requirement.oneOf : providersForArea(requirement.capability);
    return {
      ...requirement,
      candidates: candidateIds.map((id) => ({ id, name: getProviderProfile(id)?.name ?? id })),
      satisfiedBy: [...connections.values()],
    };
  });

  // Only tools from connections that satisfy one of the skill's capabilities: a
  // skill that needs a code host does not get a finance tool that happens to share a permission name.
  const relevant = new Set(requirements.flatMap((requirement) => requirement.satisfiedBy.map((entry) => entry.connectionId)));
  const toolsFor = (permission: string) => withSchema.filter((tool) => tool.permission === permission && relevant.has(tool.source.connectionId)).map(planned);
  const permissions = [
    ...skill.requirements.permissions.map((permission) => ({ permission, approval: false, tools: toolsFor(permission) })),
    ...skill.requirements.approvals.map((permission) => ({ permission, approval: true, tools: toolsFor(permission) })),
  ];
  const missing = requirements.filter((requirement) => requirement.required && requirement.satisfiedBy.length === 0).map((requirement) => requirement.capability);
  return {
    skillId: skill.id,
    requirements,
    permissions,
    ready: missing.length === 0,
    missing,
    unavailable: permissions.filter((entry) => entry.tools.length === 0).map((entry) => entry.permission),
  };
}

export class SkillNotReadyError extends Error {
  constructor(readonly missing: string[]) {
    super(`Connect ${missing.map((capability) => capability.replaceAll('_', ' ')).join(' and ')} first`);
  }
}

export class CapabilitiesNotAcknowledgedError extends Error {
  constructor(readonly capabilities: string[]) {
    super(`These tools run with ${capabilities.join(', ')} access on this server. Acknowledge that to authorize the skill.`);
  }
}

/**
 * Gives an agent a skill and exactly the access its plan lists: each tool is
 * granted (attributed to the skill), routine permissions run without asking,
 * approval permissions ask every time. Existing grants and stricter rules the
 * agent already has are left alone -- authorizing a skill never loosens a block.
 */
export function authorizeSkill(db: Database, input: {
  skill: Skill; agentId: string; userId: string; acknowledgeCapabilities?: string[]; config?: Record<string, string>;
}): SkillPlan {
  const plan = planSkill(db, input.skill);
  if (!plan.ready) throw new SkillNotReadyError(plan.missing);
  const tools = plan.permissions.flatMap((entry) => entry.tools);
  const unacknowledged = [...new Set(tools.flatMap((tool) => tool.serverCapabilities))].filter((capability) => !(input.acknowledgeCapabilities ?? []).includes(capability));
  if (unacknowledged.length) throw new CapabilitiesNotAcknowledgedError(unacknowledged);

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const tool of tools) {
      if (tool.connectionKind === 'connector') {
        db.prepare(`INSERT INTO connector_grants (connector_id, grantee_type, grantee_id, capability, created_at, source_skill_id)
          VALUES (?, 'agent', ?, ?, ?, ?) ON CONFLICT (connector_id, grantee_type, grantee_id, capability) DO NOTHING`)
          .run(tool.connectionId, input.agentId, tool.toolName, now, input.skill.id);
      } else {
        db.prepare(`INSERT INTO agent_mcp_tools (agent_id, server_id, tool_name, granted_capabilities, created_at, source_skill_id)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (agent_id, server_id, tool_name) DO UPDATE SET granted_capabilities = excluded.granted_capabilities`)
          .run(input.agentId, tool.connectionId, tool.toolName, JSON.stringify(tool.serverCapabilities), now, input.skill.id);
      }
    }
    const existing = new Map((db.prepare(`SELECT selector, mode FROM tool_policies WHERE agent_id = ? AND selector_type = 'permission'`)
      .all(input.agentId) as Array<{ selector: string; mode: string }>).map((row) => [row.selector, row.mode]));
    for (const entry of plan.permissions) {
      const current = existing.get(entry.permission);
      if (current === 'blocked') continue;
      if (entry.approval) {
        setToolPolicy(db, { agentId: input.agentId, selectorType: 'permission', selector: entry.permission, mode: 'ask_every_time', sourceSkillId: input.skill.id, userId: input.userId });
      } else if (!current) {
        setToolPolicy(db, { agentId: input.agentId, selectorType: 'permission', selector: entry.permission, mode: 'always', sourceSkillId: input.skill.id, userId: input.userId });
      }
    }
    const assigned = db.prepare('SELECT config, enabled FROM agent_skills WHERE agent_id = ? AND skill_id = ?').get(input.agentId, input.skill.id) as { config: string; enabled: number } | undefined;
    upsertAgentSkill(db, input.agentId, { skillId: input.skill.id, enabled: true, config: input.config ?? (assigned ? JSON.parse(assigned.config) : {}) }, now);
    db.prepare('UPDATE agent_skills SET authorized_at = ?, authorized_by = ? WHERE agent_id = ? AND skill_id = ?').run(now, input.userId, input.agentId, input.skill.id);
  })();
  return plan;
}
