import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/driver.js';
import { createSkill, getSkill, parseSkillManifest, updateSkill } from '../skills/skills.js';
import { createMcpServer, getMcpServer, updateMcpServer, type McpCapability } from '../mcp/repository.js';

const SecretReference = /^\{\{\s*secret:[A-Z][A-Z0-9_]*\s*\}\}$/;
const RegistryVersionSchema = z.object({ version: z.string().min(1).max(40), manifest: z.unknown() });
export const RegistryItemSchema = z.object({
  id: z.string().min(1).max(200), type: z.enum(['skill', 'mcp_preset']), name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''), publisher: z.string().min(1).max(100), verified: z.boolean().default(false),
  compatibility: z.string().max(100).default('*'), requiredCapabilities: z.array(z.string().max(80)).max(50).default([]),
  requiredSecrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(50).default([]),
  versions: z.array(RegistryVersionSchema).min(1).max(100),
});
export type RegistryItem = z.infer<typeof RegistryItemSchema>;

export function getRegistrySettings(db: Database): { enabled: boolean; registryUrl: string | null; allowUnverified: boolean } {
  const row = db.prepare('SELECT enabled, registry_url, allow_unverified FROM registry_settings WHERE id = 1').get() as { enabled: number; registry_url: string | null; allow_unverified: number };
  return { enabled: Boolean(row.enabled), registryUrl: row.registry_url, allowUnverified: Boolean(row.allow_unverified) };
}
export function updateRegistrySettings(db: Database, input: { enabled: boolean; registryUrl: string | null; allowUnverified: boolean; userId: string }) {
  db.prepare('UPDATE registry_settings SET enabled = ?, registry_url = ?, allow_unverified = ?, updated_by = ?, updated_at = ? WHERE id = 1')
    .run(input.enabled ? 1 : 0, input.registryUrl, input.allowUnverified ? 1 : 0, input.userId, new Date().toISOString());
  return getRegistrySettings(db);
}

export async function fetchRegistryItems(db: Database, fetchImpl: typeof fetch): Promise<RegistryItem[]> {
  const settings = getRegistrySettings(db); if (!settings.enabled || !settings.registryUrl) throw new Error('registry_disabled');
  const response = await fetchImpl(settings.registryUrl, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`registry_unavailable_${response.status}`);
  const body = await response.json() as { items?: unknown }; return z.array(RegistryItemSchema).max(10_000).parse(body.items ?? []);
}

function manifestText(value: unknown): string { if (typeof value !== 'string') throw new Error('registry_skill_manifest_invalid'); return value; }
function mcpManifest(value: unknown): { name: string; transport: 'http' | 'stdio'; url?: string; command?: string; args?: string[]; headers?: Record<string, string>; env?: Record<string, string>; capabilities?: McpCapability[] } {
  const parsed = z.object({ name: z.string().min(1).max(60), transport: z.enum(['http','stdio']), url: z.string().url().optional(), command: z.string().min(1).optional(),
    args: z.array(z.string()).max(64).default([]), headers: z.record(z.string(), z.string()).default({}), env: z.record(z.string(), z.string()).default({}),
    capabilities: z.array(z.enum(['shell','filesystem','network'])).default([]) }).parse(value);
  for (const field of [...Object.values(parsed.headers), ...Object.values(parsed.env)]) {
    if (field && !SecretReference.test(field) && !/^(Bearer|Basic|Token|Bot)\s*$/i.test(field)) throw new Error('registry_presets_may_only_reference_secrets');
  }
  return parsed;
}

export function listRegistryInstallations(db: Database): Array<Record<string, unknown>> {
  return db.prepare(`SELECT id, item_type AS itemType, registry_id AS registryId, name, publisher, version, pinned_version AS pinnedVersion,
    verified, installed_resource_id AS installedResourceId, installed_at AS installedAt, updated_at AS updatedAt FROM registry_installations ORDER BY name`).all() as Array<Record<string, unknown>>;
}

export function installRegistryItem(db: Database, item: RegistryItem, version: string | undefined, userId: string): Record<string, unknown> {
  const settings = getRegistrySettings(db); if (!item.verified && !settings.allowUnverified) throw new Error('unverified_registry_item_blocked');
  const selected = item.versions.find((entry) => entry.version === version) ?? item.versions.at(-1)!;
  const existing = db.prepare('SELECT id, installed_resource_id, version, manifest FROM registry_installations WHERE item_type = ? AND registry_id = ?')
    .get(item.type, item.id) as { id: string; installed_resource_id: string | null; version: string; manifest: string } | undefined;
  let resourceId: string;
  if (item.type === 'skill') {
    const parsed = parseSkillManifest(manifestText(selected.manifest));
    const skill = existing?.installed_resource_id ? getSkill(db, existing.installed_resource_id) : undefined;
    resourceId = skill ? updateSkill(db, skill.id, { ...parsed, version: selected.version })!.id
      : createSkill(db, { ...parsed, source: 'installed', sourceRef: `registry:${item.id}`, version: selected.version }, userId).id;
  } else {
    const parsed = mcpManifest(selected.manifest); const server = existing?.installed_resource_id ? getMcpServer(db, existing.installed_resource_id) : undefined;
    resourceId = server ? updateMcpServer(db, server.id, parsed)!.id : createMcpServer(db, parsed).id;
  }
  const now = new Date().toISOString(); const id = existing?.id ?? randomUUID();
  db.prepare(`INSERT INTO registry_installations (id, item_type, registry_id, name, publisher, version, verified, manifest, installed_resource_id, installed_by, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_type, registry_id) DO UPDATE SET name=excluded.name, publisher=excluded.publisher, version=excluded.version,
      verified=excluded.verified, manifest=excluded.manifest, installed_resource_id=excluded.installed_resource_id, installed_by=excluded.installed_by, updated_at=excluded.updated_at`)
    .run(id, item.type, item.id, item.name, item.publisher, selected.version, item.verified ? 1 : 0, JSON.stringify(selected.manifest), resourceId, userId, now, now);
  return listRegistryInstallations(db).find((entry) => entry.id === id)!;
}

export function pinRegistryInstallation(db: Database, id: string, version: string | null): void {
  if (!db.prepare('UPDATE registry_installations SET pinned_version = ?, updated_at = ? WHERE id = ?').run(version, new Date().toISOString(), id).changes) throw new Error('registry_installation_not_found');
}
