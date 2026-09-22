import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface SkillConfigField {
  key: string;
  label: string;
  /** Holds a `{{secret:NAME}}` reference, never a value, and is never shown to the model. */
  secret: boolean;
  required: boolean;
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
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkill {
  skillId: string;
  slug: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
}

export interface SkillInput {
  name: string;
  slug?: string;
  description?: string;
  instructions: string;
  configFields?: SkillConfigField[];
  version?: string;
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
}
