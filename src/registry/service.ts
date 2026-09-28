import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/driver.js';
import { createSkill, getSkill, parseSkillManifest, updateSkill } from '../skills/skills.js';
import { createMcpServer, getMcpServer, updateMcpServer, type McpCapability } from '../mcp/repository.js';
import { fetchPublicHttps, parsePublicHttpsUrl } from '../security/outbound.js';
import { CATALOG, isCatalogId } from './catalog.js';
import { detectProvider } from '../tools/providers.js';
import type { TrustLevel } from '../tools/types.js';
import { mcpListing, RegistryListingSchema } from './listing.js';

export { mcpListing, RegistryListingSchema, type RegistryListing } from './listing.js';


const OFFICIAL_MCP_REGISTRY = 'https://registry.modelcontextprotocol.io';
const OFFICIAL_MCP_PREFIX = 'mcp-registry/';

// A preset value may hold only secret references, optionally after an auth scheme ("Bearer {{secret:X}}").
const SecretReferences = /\{\{\s*secret:[A-Z][A-Z0-9_]*\s*\}\}/g;
const RegistryVersionSchema = z.object({ version: z.string().min(1).max(40), manifest: z.unknown() });

export const RegistryItemSchema = z.object({
  id: z.string().min(1).max(200), type: z.enum(['skill', 'mcp_preset']), name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''), publisher: z.string().min(1).max(100), verified: z.boolean().default(false),
  compatibility: z.string().max(100).default('*'), requiredCapabilities: z.array(z.string().max(80)).max(50).default([]),
  requiredSecrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(50).default([]),
  versions: z.array(RegistryVersionSchema).min(1).max(100),
  listing: RegistryListingSchema.optional(),
});
export type RegistryItem = z.infer<typeof RegistryItemSchema>;

const OfficialRemoteSchema = z.object({
  type: z.enum(['streamable-http', 'sse']), url: z.string(), headers: z.array(z.unknown()).optional(), variables: z.record(z.string(), z.unknown()).optional(),
});
const OfficialServerSchema = z.object({
  name: z.string().min(3).max(200), title: z.string().min(1).max(100).optional(), description: z.string().min(1).max(1000),
  version: z.string().min(1).max(255), remotes: z.array(OfficialRemoteSchema).optional(),
});
const OfficialResponseSchema = z.object({ server: OfficialServerSchema, _meta: z.record(z.string(), z.unknown()).optional() });

function officialMcpItem(value: unknown): RegistryItem | undefined {
  const parsed = OfficialResponseSchema.safeParse(value); if (!parsed.success) return undefined;
  const server = parsed.data.server;
  const remote = server.remotes?.find((entry) => entry.type === 'streamable-http' && !entry.headers?.length && !Object.keys(entry.variables ?? {}).length && !entry.url.includes('{'));
  if (!remote) return undefined;
  try { parsePublicHttpsUrl(remote.url); } catch { return undefined; }
  const namespace = server.name.split('/')[0]!;
  // The registry verifies ownership of a domain namespace (com.stripe/...), so its publisher is who it says.
  // A GitHub namespace only proves a GitHub account: that is a community listing.
  const trust: TrustLevel = /^io\.github\./.test(namespace) ? 'community' : 'official';
  const meta = parsed.data._meta?.['io.modelcontextprotocol.registry/official'] as { updatedAt?: string } | undefined;
  const repository = (value as { server?: { repository?: { url?: string } } }).server?.repository?.url ?? null;
  return {
    id: `${OFFICIAL_MCP_PREFIX}${server.name}`, type: 'mcp_preset', name: server.title ?? server.name.split('/').at(-1)!,
    description: server.description, publisher: `MCP Registry · ${namespace}`, verified: false, compatibility: '*',
    requiredCapabilities: ['network.access'], requiredSecrets: [], versions: [{ version: server.version,
      manifest: { name: server.title ?? server.name.split('/').at(-1)!, transport: 'http', url: remote.url, headers: {}, capabilities: ['network'] } }],
    listing: mcpListing({ url: remote.url, transport: 'http', trust, secrets: [], repository, updatedAt: meta?.updatedAt ?? null }),
  };
}

/** The official registry is read at most every few minutes per query, not on every page view. */
const OFFICIAL_CACHE_TTL_MS = 10 * 60_000;
const officialCache = new Map<string, { at: number; items: RegistryItem[] }>();

export async function fetchOfficialMcpItems(query = '', fetchImpl?: typeof fetch): Promise<RegistryItem[]> {
  const key = query.trim().toLowerCase();
  const cached = officialCache.get(key);
  if (cached && Date.now() - cached.at < OFFICIAL_CACHE_TTL_MS && !fetchImpl) return cached.items;
  const items = await fetchOfficialMcpItemsUncached(query, fetchImpl);
  if (!fetchImpl) {
    if (officialCache.size > 200) officialCache.clear();
    officialCache.set(key, { at: Date.now(), items });
  }
  return items;
}

async function fetchOfficialMcpItemsUncached(query: string, fetchImpl?: typeof fetch): Promise<RegistryItem[]> {
  const url = new URL('/v0.1/servers', OFFICIAL_MCP_REGISTRY);
  url.searchParams.set('version', 'latest'); url.searchParams.set('limit', '100');
  if (query.trim()) url.searchParams.set('search', query.trim());
  const response = await fetchPublicHttps(url.toString(), { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }, fetchImpl);
  if (!response.ok) throw new Error(`official_mcp_registry_unavailable_${response.status}`);
  const body = await response.json() as { servers?: unknown[] };
  return (body.servers ?? []).map(officialMcpItem).filter((item): item is RegistryItem => Boolean(item));
}

async function findOfficialMcpItem(id: string, fetchImpl?: typeof fetch): Promise<RegistryItem | undefined> {
  const name = id.slice(OFFICIAL_MCP_PREFIX.length); if (!name) return undefined;
  const url = new URL(`/v0.1/servers/${encodeURIComponent(name)}/versions/latest`, OFFICIAL_MCP_REGISTRY);
  const response = await fetchPublicHttps(url.toString(), { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }, fetchImpl);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`official_mcp_registry_unavailable_${response.status}`);
  return officialMcpItem(await response.json());
}

export function getRegistrySettings(db: Database): { enabled: boolean; registryUrl: string | null; allowUnverified: boolean } {
  const row = db.prepare('SELECT enabled, registry_url, allow_unverified FROM registry_settings WHERE id = 1').get() as { enabled: number; registry_url: string | null; allow_unverified: number };
  return { enabled: Boolean(row.enabled), registryUrl: row.registry_url, allowUnverified: Boolean(row.allow_unverified) };
}
export function updateRegistrySettings(db: Database, input: { enabled: boolean; registryUrl: string | null; allowUnverified: boolean; userId: string }) {
  db.prepare('UPDATE registry_settings SET enabled = ?, registry_url = ?, allow_unverified = ?, updated_by = ?, updated_at = ? WHERE id = 1')
    .run(input.enabled ? 1 : 0, input.registryUrl, input.allowUnverified ? 1 : 0, input.userId, new Date().toISOString());
  return getRegistrySettings(db);
}

export async function fetchRegistryItems(db: Database, fetchImpl?: typeof fetch): Promise<RegistryItem[]> {
  const settings = getRegistrySettings(db); if (!settings.enabled || !settings.registryUrl) throw new Error('registry_disabled');
  const response = await fetchPublicHttps(settings.registryUrl, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }, fetchImpl);
  if (!response.ok) throw new Error(`registry_unavailable_${response.status}`);
  const body = await response.json() as { items?: unknown };
  return z.array(RegistryItemSchema).max(10_000).parse(body.items ?? []).map((item) => ({
    ...item,
    // A private registry the owner chose may vouch for its items, but it cannot make them official.
    listing: item.listing ? { ...item.listing, trust: item.verified ? 'verified' as const : item.listing.trust === 'official' ? 'community' as const : item.listing.trust } : undefined,
  }));
}

/**
 * Everything an owner can install: the built-in Crewly catalog, always, plus
 * the configured registry when it is enabled. A registry cannot shadow a
 * catalog item, so "Crewly · verified" always means the one shipped here.
 */
export async function listRegistryItems(db: Database, fetchImpl?: typeof fetch, options: { query?: string; type?: RegistryItem['type'] } = {}): Promise<RegistryItem[]> {
  const settings = getRegistrySettings(db);
  const remote = settings.enabled && settings.registryUrl ? await fetchRegistryItems(db, fetchImpl) : [];
  const official = options.type === 'skill' ? [] : await fetchOfficialMcpItems(options.query, fetchImpl).catch(() => []);
  return [...CATALOG, ...official, ...remote.filter((item) => !isCatalogId(item.id) && !item.id.startsWith(OFFICIAL_MCP_PREFIX))];
}

export async function findRegistryItem(db: Database, id: string, type: RegistryItem['type'], fetchImpl?: typeof fetch): Promise<RegistryItem | undefined> {
  if (isCatalogId(id)) return CATALOG.find((item) => item.id === id && item.type === type);
  if (id.startsWith(OFFICIAL_MCP_PREFIX)) return type === 'mcp_preset' ? findOfficialMcpItem(id, fetchImpl) : undefined;
  return (await listRegistryItems(db, fetchImpl, { type })).find((item) => item.id === id && item.type === type);
}

function manifestText(value: unknown): string { if (typeof value !== 'string') throw new Error('registry_skill_manifest_invalid'); return value; }
function mcpManifest(value: unknown): { name: string; transport: 'http' | 'stdio'; url?: string; command?: string; args?: string[]; headers?: Record<string, string>; env?: Record<string, string>; capabilities?: McpCapability[] } {
  const parsed = z.object({ name: z.string().min(1).max(60), transport: z.enum(['http','stdio']), url: z.string().url().optional(), command: z.string().min(1).optional(),
    args: z.array(z.string()).max(64).default([]), headers: z.record(z.string(), z.string()).default({}), env: z.record(z.string(), z.string()).default({}),
    capabilities: z.array(z.enum(['shell','filesystem','network'])).default([]) }).parse(value);
  for (const field of [...Object.values(parsed.headers), ...Object.values(parsed.env)]) {
    const literal = field.replace(SecretReferences, '').trim();
    if (literal && !/^(Bearer|Basic|Token|Bot)$/i.test(literal)) throw new Error('registry_presets_may_only_reference_secrets');
  }
  if (parsed.transport === 'stdio') throw new Error('registry_stdio_presets_not_allowed');
  if (!parsed.url) throw new Error('registry_mcp_url_required');
  parsePublicHttpsUrl(parsed.url);
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
    const trust: TrustLevel = isCatalogId(item.id) ? (item.listing?.trust ?? 'verified') : item.verified ? 'verified' : (item.listing?.trust === 'community' ? 'community' : 'unverified');
    const connection = { ...parsed, trust, registryId: item.id, provider: item.listing?.provider ?? detectProvider(parsed.url) };
    resourceId = server ? updateMcpServer(db, server.id, connection)!.id : createMcpServer(db, connection).id;
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
