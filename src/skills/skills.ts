import { randomUUID } from 'node:crypto';
import type { Agent } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import type { InstructionProvider } from '../providers/respond.js';
import { findSecretReferences, registerGranteeNamer, registerSecretReferenceScanner } from '../secrets/vault.js';

export interface SkillConfigField {
  key: string;
  label: string;
  /** A secret field holds a {{secret:NAME}} reference and is never shown to the model. */
  secret: boolean;
  required: boolean;
}

/**
 * What a skill needs, stated as capabilities rather than vendors: a bug
 * fixer needs error tracking (Sentry, Datadog or New Relic) and a code host
 * (GitHub or GitLab), not "Sentry". An empty `oneOf` accepts any provider
 * with that capability.
 */
export interface SkillRequirement {
  capability: string;
  oneOf: string[];
}

export interface SkillRequirements {
  requires: SkillRequirement[];
  optional: SkillRequirement[];
  /** Permissions the skill uses routinely; authorizing it lets them run without asking. */
  permissions: string[];
  /** Permissions it may use, but only with a person's approval every time. */
  approvals: string[];
  /** Model preferences, by role, for runtimes that honour them. */
  models?: Partial<Record<'preferred' | 'fallback' | 'cheap' | 'reasoning' | 'vision' | 'embedding', string>>;
}

export const EMPTY_REQUIREMENTS: SkillRequirements = { requires: [], optional: [], permissions: [], approvals: [] };

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
  requirements: SkillRequirements;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkill {
  skillId: string;
  slug: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  /** When someone authorized the permissions it declares for this agent, if they have. */
  authorizedAt: string | null;
}

export class SkillValidationError extends Error {}
export class SkillExistsError extends Error {}

interface SkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  config_fields: string;
  source: 'custom' | 'installed';
  source_ref: string | null;
  version: string;
  requirements: string;
  created_at: string;
  updated_at: string;
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    configFields: JSON.parse(row.config_fields),
    source: row.source,
    sourceRef: row.source_ref,
    version: row.version,
    requirements: { ...EMPTY_REQUIREMENTS, ...(JSON.parse(row.requirements || '{}') as Partial<SkillRequirements>) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
}

export interface SkillInput {
  name: string;
  slug?: string;
  description?: string;
  instructions: string;
  configFields?: SkillConfigField[];
  source?: 'custom' | 'installed';
  sourceRef?: string | null;
  version?: string;
  requirements?: SkillRequirements;
}

export function createSkill(db: Database, input: SkillInput, createdBy: string | null): Skill {
  const now = new Date().toISOString();
  const id = randomUUID();
  const slug = input.slug ?? slugify(input.name);
  if (db.prepare('SELECT 1 FROM skills WHERE slug = ?').get(slug)) throw new SkillExistsError(`A skill called "${slug}" already exists`);
  db.prepare(
    `INSERT INTO skills (id, slug, name, description, instructions, config_fields, source, source_ref, version, requirements, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, slug, input.name, input.description ?? '', input.instructions, JSON.stringify(input.configFields ?? []),
    input.source ?? 'custom', input.sourceRef ?? null, input.version ?? '1', JSON.stringify(input.requirements ?? EMPTY_REQUIREMENTS), createdBy, now, now,
  );
  return getSkill(db, id)!;
}

export function getSkill(db: Database, id: string): Skill | undefined {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;
  return row ? rowToSkill(row) : undefined;
}

export function listSkills(db: Database): Skill[] {
  return (db.prepare('SELECT * FROM skills ORDER BY name').all() as SkillRow[]).map(rowToSkill);
}

export function updateSkill(db: Database, id: string, input: Partial<SkillInput>): Skill | undefined {
  const existing = getSkill(db, id);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE skills SET name = ?, description = ?, instructions = ?, config_fields = ?, version = ?, requirements = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.name ?? existing.name,
    input.description ?? existing.description,
    input.instructions ?? existing.instructions,
    JSON.stringify(input.configFields ?? existing.configFields),
    input.version ?? existing.version,
    JSON.stringify(input.requirements ?? existing.requirements),
    new Date().toISOString(),
    id,
  );
  return getSkill(db, id);
}

export function deleteSkill(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM skills WHERE id = ?').run(id).changes > 0;
}

/**
 * Reads a skill manifest: `---` frontmatter of `key: value` lines (name,
 * description, version, and `config` as a JSON array of fields), then the
 * instructions as markdown. The shape a future registry would serve.
 */
export function parseSkillManifest(text: string): SkillInput {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trim());
  if (!match) throw new SkillValidationError('A skill manifest starts with --- frontmatter --- followed by its instructions');
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (pair) meta[pair[1]!.toLowerCase()] = pair[2]!.trim().replace(/^["']|["']$/g, '');
  }
  if (!meta.name) throw new SkillValidationError('The manifest needs a name');
  const instructions = match[2]!.trim();
  if (!instructions) throw new SkillValidationError('The manifest has no instructions');
  let configFields: SkillConfigField[] = [];
  if (meta.config) {
    try {
      configFields = (JSON.parse(meta.config) as Array<Partial<SkillConfigField>>).map((field) => ({
        key: String(field.key),
        label: String(field.label ?? field.key),
        secret: Boolean(field.secret),
        required: Boolean(field.required),
      }));
    } catch {
      throw new SkillValidationError('config must be a JSON array of {key, label, secret, required}');
    }
  }
  return {
    name: meta.name,
    slug: meta.slug,
    description: meta.description ?? '',
    version: meta.version ?? '1',
    instructions,
    configFields,
    requirements: parseRequirements(meta),
    source: 'installed',
  };
}

const CAPABILITY = /^[a-z][a-z0-9_]{0,40}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,40}$/;
const PERMISSION = /^[a-z][a-z0-9_.]*:[a-z][a-z0-9_]*$/;

function jsonField(meta: Record<string, string>, key: string): unknown {
  if (!meta[key]) return undefined;
  try {
    return JSON.parse(meta[key]!);
  } catch {
    throw new SkillValidationError(`${key} must be JSON on one line`);
  }
}

/**
 * `requires` and `optional` map a capability to the providers that can
 * supply it: {"error_tracking": ["sentry", "datadog"], "code_host": []}.
 * `permissions` and `approvals` are lists of `resource:action`.
 */
export function parseRequirements(meta: Record<string, string>): SkillRequirements {
  const capabilityMap = (key: string): SkillRequirement[] => {
    const value = jsonField(meta, key);
    if (value === undefined) return [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SkillValidationError(`${key} maps each capability to a list of providers`);
    return Object.entries(value as Record<string, unknown>).map(([capability, providers]) => {
      if (!CAPABILITY.test(capability)) throw new SkillValidationError(`${key}: "${capability}" is not a capability name`);
      const list = providers === true ? [] : providers;
      if (!Array.isArray(list) || list.some((provider) => typeof provider !== 'string' || !PROVIDER.test(provider))) {
        throw new SkillValidationError(`${key}.${capability} must list provider ids`);
      }
      return { capability, oneOf: list as string[] };
    });
  };
  const permissionList = (key: string): string[] => {
    const value = jsonField(meta, key);
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !PERMISSION.test(entry))) {
      throw new SkillValidationError(`${key} must be a list of resource:action permissions`);
    }
    return [...new Set(value as string[])];
  };
  const models = jsonField(meta, 'models');
  return {
    requires: capabilityMap('requires'),
    optional: capabilityMap('optional'),
    permissions: permissionList('permissions'),
    approvals: permissionList('approvals'),
    ...(models && typeof models === 'object' && !Array.isArray(models) ? { models: models as SkillRequirements['models'] } : {}),
  };
}

/**
 * Checks an assignment's values against the skill's fields. A secret field
 * must be exactly one {{secret:NAME}} reference: a pasted value would end up
 * stored in plain configuration.
 */
export function validateSkillConfig(skill: Skill, config: Record<string, string>): void {
  for (const field of skill.configFields) {
    const value = config[field.key];
    if (field.required && !value) throw new SkillValidationError(`${field.label} is required`);
    if (field.secret && value && !/^\{\{\s*secret:[A-Z][A-Z0-9_]*\s*\}\}$/.test(value)) {
      throw new SkillValidationError(`${field.label} is a secret: choose one from the vault ({{secret:NAME}}) instead of pasting it`);
    }
  }
  const unknown = Object.keys(config).filter((key) => !skill.configFields.some((field) => field.key === key));
  if (unknown.length) throw new SkillValidationError(`Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
}

export function listAgentSkills(db: Database, agentId: string): AgentSkill[] {
  return (db
    .prepare(
      `SELECT a.skill_id, s.slug, s.name, a.enabled, a.config, a.authorized_at FROM agent_skills a JOIN skills s ON s.id = a.skill_id
       WHERE a.agent_id = ? ORDER BY s.name`,
    )
    .all(agentId) as Array<{ skill_id: string; slug: string; name: string; enabled: number; config: string; authorized_at: string | null }>)
    .map((row) => ({ skillId: row.skill_id, slug: row.slug, name: row.name, enabled: row.enabled === 1, config: JSON.parse(row.config), authorizedAt: row.authorized_at }));
}

/** Replaces an agent's skills. A skill that stays keeps its authorization. */
export function setAgentSkills(
  db: Database,
  agentId: string,
  skills: Array<{ skillId: string; enabled: boolean; config: Record<string, string> }>,
): void {
  db.transaction(() => {
    const keep = new Set(skills.map((skill) => skill.skillId));
    for (const existing of db.prepare('SELECT skill_id FROM agent_skills WHERE agent_id = ?').pluck().all(agentId) as string[]) {
      if (!keep.has(existing)) db.prepare('DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?').run(agentId, existing);
    }
    const now = new Date().toISOString();
    for (const skill of skills) upsertAgentSkill(db, agentId, skill, now);
  })();
}

export function upsertAgentSkill(db: Database, agentId: string, skill: { skillId: string; enabled: boolean; config: Record<string, string> }, now = new Date().toISOString()): void {
  db.prepare(`INSERT INTO agent_skills (agent_id, skill_id, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (agent_id, skill_id) DO UPDATE SET config = excluded.config, enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .run(agentId, skill.skillId, JSON.stringify(skill.config), skill.enabled ? 1 : 0, now, now);
}

/**
 * What a skill contributes to an agent's system prompt: its instructions,
 * with `{{config.KEY}}` filled from non-secret settings. Secret settings are
 * never rendered -- the prompt goes to a model provider -- and are named only
 * as configured.
 */
export function renderSkill(skill: Skill, config: Record<string, string>): string {
  const plain = (key: string) => {
    const field = skill.configFields.find((candidate) => candidate.key === key);
    if (!field) return `{{config.${key}}}`;
    if (field.secret) return `[${field.label}: configured]`;
    return config[key] ?? '';
  };
  const body = skill.instructions.replace(/\{\{\s*config\.([A-Za-z0-9_]+)\s*\}\}/g, (_m, key: string) => plain(key));
  const settings = skill.configFields
    .filter((field) => config[field.key])
    .map((field) => `- ${field.label}: ${field.secret ? 'configured (secret)' : config[field.key]}`);
  const needs = skill.requirements.requires.map((entry) => entry.capability.replaceAll('_', ' '));
  const asks = skill.requirements.approvals;
  const tools = [
    needs.length ? `Uses: ${needs.join(', ')}. Find the tools with search_tools when they are not listed.` : '',
    asks.length ? `Always needs a person's approval: ${asks.join(', ')}. Request it through the tool and wait; never work around it.` : '',
  ].filter(Boolean).join('\n');
  return [`## Skill: ${skill.name}`, body, tools, settings.length ? `Settings:\n${settings.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

export function skillInstructions(db: Database): InstructionProvider {
  return (agent: Agent) => {
    const assigned = listAgentSkills(db, agent.id).filter((entry) => entry.enabled);
    if (assigned.length === 0) return undefined;
    const rendered = assigned
      .map((entry) => {
        const skill = getSkill(db, entry.skillId);
        return skill ? renderSkill(skill, entry.config) : undefined;
      })
      .filter(Boolean);
    return rendered.length ? `You have these skills:\n\n${rendered.join('\n\n')}` : undefined;
  };
}

let registered = false;

/** Tells the vault which skill assignments refer to a secret, and how to name a skill grantee. */
export function registerSkillSecretHooks(): void {
  if (registered) return;
  registered = true;
  registerSecretReferenceScanner((db, secretName) =>
    (db.prepare(
      `SELECT a.agent_id, a.skill_id, a.config, s.name AS skill_name, g.name AS agent_name
       FROM agent_skills a JOIN skills s ON s.id = a.skill_id JOIN agents g ON g.id = a.agent_id`,
    ).all() as Array<{ agent_id: string; skill_id: string; config: string; skill_name: string; agent_name: string }>)
      .filter((row) => Object.values(JSON.parse(row.config) as Record<string, string>)
        .some((value) => findSecretReferences(value).includes(secretName)))
      .map((row) => ({ type: 'skill', id: row.skill_id, name: `${row.skill_name} on ${row.agent_name}`, via: 'reference' as const })));
  registerGranteeNamer('skill', (db, id) => getSkill(db, id)?.name);
}
