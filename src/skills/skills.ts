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
}

export function createSkill(db: Database, input: SkillInput, createdBy: string | null): Skill {
  const now = new Date().toISOString();
  const id = randomUUID();
  const slug = input.slug ?? slugify(input.name);
  if (db.prepare('SELECT 1 FROM skills WHERE slug = ?').get(slug)) throw new SkillExistsError(`A skill called "${slug}" already exists`);
  db.prepare(
    `INSERT INTO skills (id, slug, name, description, instructions, config_fields, source, source_ref, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, slug, input.name, input.description ?? '', input.instructions, JSON.stringify(input.configFields ?? []),
    input.source ?? 'custom', input.sourceRef ?? null, input.version ?? '1', createdBy, now, now,
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
    `UPDATE skills SET name = ?, description = ?, instructions = ?, config_fields = ?, version = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.name ?? existing.name,
    input.description ?? existing.description,
    input.instructions ?? existing.instructions,
    JSON.stringify(input.configFields ?? existing.configFields),
    input.version ?? existing.version,
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
    source: 'installed',
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
      `SELECT a.skill_id, s.slug, s.name, a.enabled, a.config FROM agent_skills a JOIN skills s ON s.id = a.skill_id
       WHERE a.agent_id = ? ORDER BY s.name`,
    )
    .all(agentId) as Array<{ skill_id: string; slug: string; name: string; enabled: number; config: string }>)
    .map((row) => ({ skillId: row.skill_id, slug: row.slug, name: row.name, enabled: row.enabled === 1, config: JSON.parse(row.config) }));
}

export function setAgentSkills(
  db: Database,
  agentId: string,
  skills: Array<{ skillId: string; enabled: boolean; config: Record<string, string> }>,
): void {
  db.transaction(() => {
    db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(agentId);
    const insert = db.prepare(
      'INSERT INTO agent_skills (agent_id, skill_id, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const now = new Date().toISOString();
    for (const skill of skills) insert.run(agentId, skill.skillId, JSON.stringify(skill.config), skill.enabled ? 1 : 0, now, now);
  })();
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
  return [`## Skill: ${skill.name}`, body, settings.length ? `Settings:\n${settings.join('\n')}` : ''].filter(Boolean).join('\n\n');
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
