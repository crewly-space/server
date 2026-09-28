import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface SkillConfigField {
  key: string;
  label: string;
  /** Holds a `{{secret:NAME}}` reference, never a value, and is never shown to the model. */
  secret: boolean;
  required: boolean;
}

/** A capability a skill needs and the providers that can supply it; empty `oneOf` means any. */
export interface SkillRequirement {
  capability: string;
  oneOf: string[];
}

export interface SkillRequirements {
  requires: SkillRequirement[];
  optional: SkillRequirement[];
  /** Used routinely; authorizing the skill lets these run without asking. */
  permissions: string[];
  /** Always ask a person, every time. */
  approvals: string[];
  models?: Partial<Record<'preferred' | 'fallback' | 'cheap' | 'reasoning' | 'vision' | 'embedding', string>>;
}

export interface SkillPlannedTool {
  ref: string;
  connectionId: string;
  connectionName: string;
  connectionKind: 'connector' | 'mcp_server';
  toolName: string;
  risk: string;
  serverCapabilities: string[];
}

/** What authorizing a skill would take and grant, before anyone agrees to it. */
export interface SkillPlan {
  skillId: string;
  requirements: Array<SkillRequirement & {
    required: boolean;
    candidates: Array<{ id: string; name: string }>;
    satisfiedBy: Array<{ connectionId: string; connectionName: string; provider: string }>;
  }>;
  permissions: Array<{ permission: string; approval: boolean; tools: SkillPlannedTool[] }>;
  ready: boolean;
  missing: string[];
  unavailable: string[];
}

/** Reusable instructions and settings an agent can be given. Not a tool, not a runtime. */
export interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  configFields: SkillConfigField[];
  source: 'custom' | 'installed';
  sourceRef: string | null;
  version: string;
  /** Absent from servers older than the tool platform. */
  requirements?: SkillRequirements;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkill {
  skillId: string;
  slug: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  /** When its declared permissions were authorized for this agent. */
  authorizedAt?: string | null;
}

export interface SkillInput {
  name: string;
  slug?: string;
  description?: string;
  instructions: string;
  configFields?: SkillConfigField[];
  version?: string;
  requirements?: SkillRequirements;
}

export class SkillsResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<{ skills: Skill[] }> {
    return this.http.request('GET', '/api/v1/skills');
  }

  create(input: SkillInput): Promise<Skill> {
    return this.http.request('POST', '/api/v1/skills', input);
  }

  /** Installs from a manifest: `---` frontmatter (name, description, version, config) then instructions. */
  install(manifest: string, sourceRef?: string): Promise<Skill> {
    return this.http.request('POST', '/api/v1/skills/install', { manifest, sourceRef });
  }

  update(id: string, input: Partial<Omit<SkillInput, 'slug'>>): Promise<Skill> {
    return this.http.request('PATCH', `/api/v1/skills/${encodePathSegment(id)}`, input);
  }

  delete(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/skills/${encodePathSegment(id)}`);
  }

  forAgent(agentId: string): Promise<{ skills: AgentSkill[] }> {
    return this.http.request('GET', `/api/v1/agents/${encodePathSegment(agentId)}/skills`);
  }

  setForAgent(
    agentId: string,
    skills: Array<{ skillId: string; enabled?: boolean; config?: Record<string, string> }>,
  ): Promise<{ skills: AgentSkill[] }> {
    return this.http.request('PUT', `/api/v1/agents/${encodePathSegment(agentId)}/skills`, { skills });
  }

  /** Which connections satisfy the skill and exactly which tools its permissions map to. */
  plan(skillId: string): Promise<SkillPlan> {
    return this.http.request('GET', `/api/v1/skills/${encodePathSegment(skillId)}/plan`);
  }

  /** Gives the agent the skill with the access its plan lists. Needs integrations.manage. */
  authorize(
    agentId: string,
    skillId: string,
    input: { acknowledgeCapabilities?: Array<'shell' | 'filesystem' | 'network'>; config?: Record<string, string> } = {},
  ): Promise<{ plan: SkillPlan; skills: AgentSkill[] }> {
    return this.http.request('POST', `/api/v1/agents/${encodePathSegment(agentId)}/skills/${encodePathSegment(skillId)}/authorize`, input);
  }
}
