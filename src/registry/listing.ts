import { z } from 'zod';
import { detectProvider, getProviderProfile } from '../tools/providers.js';
import { TRUST_LEVELS, type TrustLevel } from '../tools/types.js';

/**
 * What a marketplace listing shows before anything is installed. Trust is
 * never taken from the listing itself for items outside the Crewly catalog:
 * a third-party registry cannot call its own entries official.
 */
export const RegistryListingSchema = z.object({
  category: z.string().max(40).default('other'),
  provider: z.string().max(60).nullable().default(null),
  trust: z.enum(TRUST_LEVELS).default('unverified'),
  sourceRepository: z.string().max(500).nullable().default(null),
  updatedAt: z.string().max(40).nullable().default(null),
  transport: z.enum(['http', 'stdio', 'none']).default('none'),
  auth: z.string().max(40).default('none'),
  toolsCount: z.number().int().nullable().default(null),
  readPermissions: z.array(z.string().max(80)).max(100).default([]),
  writePermissions: z.array(z.string().max(80)).max(100).default([]),
  networkAccess: z.boolean().default(false),
  filesystemAccess: z.boolean().default(false),
  secretsRequired: z.array(z.string().max(80)).max(50).default([]),
  risk: z.enum(['low', 'medium', 'high']).default('medium'),
  featured: z.boolean().default(false),
});
export type RegistryListing = z.infer<typeof RegistryListingSchema>;

const HIGH_RISK_CATEGORIES = new Set(['finance', 'cloud', 'databases', 'identity', 'automation', 'browser']);
const LOW_RISK_CATEGORIES = new Set(['knowledge', 'ai', 'other']);

/** A listing for an MCP server, from what its URL and provider say about it. */
export function mcpListing(input: { url?: string; transport: 'http' | 'stdio'; trust: TrustLevel; secrets: string[]; repository?: string | null; updatedAt?: string | null; featured?: boolean; auth?: string }): RegistryListing {
  const provider = detectProvider(input.url);
  const profile = getProviderProfile(provider);
  const category = profile?.category ?? 'other';
  const oauth = profile?.integrations.find((integration) => integration.kind === 'mcp')?.auth === 'mcp_oauth';
  return RegistryListingSchema.parse({
    category, provider, trust: input.trust, sourceRepository: input.repository ?? null, updatedAt: input.updatedAt ?? null,
    transport: input.transport, auth: input.auth ?? (input.secrets.length ? 'mcp_token' : oauth ? 'mcp_oauth' : 'none'),
    networkAccess: true, filesystemAccess: input.transport === 'stdio', secretsRequired: input.secrets,
    risk: input.transport === 'stdio' || input.trust === 'unverified' || HIGH_RISK_CATEGORIES.has(category) ? 'high' : LOW_RISK_CATEGORIES.has(category) ? 'low' : 'medium',
    featured: input.featured ?? false,
  });
}
