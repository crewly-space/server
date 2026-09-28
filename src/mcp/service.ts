import type { Database } from '../db/driver.js';
import {
  findSecretReferences,
  registerGranteeNamer,
  registerSecretReferenceScanner,
  readSecretFor,
  SecretAccessError,
  type Grantee,
} from '../secrets/vault.js';
import { callMcpTool, discoverMcpServer, McpError, type McpClientOptions, type McpToolInfo, type McpTransportConfig } from './client.js';
import { getMcpServer, listMcpServers, recordCallOutcome, recordDiscovery, type McpServerRecord } from './repository.js';
import { mcpAccessToken } from './oauth.js';

/** What stands in for a literal credential when a server's config is shown. */
export const REDACTED = '••••••';

function grantee(server: Pick<McpServerRecord, 'id'>): Grantee {
  return { type: 'mcp_server', id: server.id };
}

/**
 * The server's connection settings with every {{secret:NAME}} filled in --
 * only secrets granted to this MCP server resolve, and each read is audited --
 * and, for a server signed in with OAuth, a current access token attached.
 * Also returns the literal values it filled in, so an audit record can scrub them.
 */
export async function resolveTransport(db: Database, server: McpServerRecord, fetchImpl?: typeof fetch): Promise<{ config: McpTransportConfig; secrets: string[] }> {
  const secrets: string[] = [];
  // Each secret is read once per call, and its value kept only to scrub it from the audit record.
  const cache = new Map<string, string>();
  const fill = (value: string) => value.replace(/\{\{\s*secret:([A-Z][A-Z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    if (!cache.has(name)) {
      const secret = readSecretFor(db, name, grantee(server));
      cache.set(name, secret);
      secrets.push(secret);
    }
    return cache.get(name)!;
  });
  const fillAll = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, fill(value)]));
  if (server.transport === 'http') {
    const headers = fillAll(server.headers);
    const token = await mcpAccessToken(db, server, fetchImpl);
    if (token) {
      headers.authorization = `Bearer ${token}`;
      secrets.push(token);
    }
    return { config: { transport: 'http', url: fill(server.url!), headers }, secrets };
  }
  return { config: { transport: 'stdio', command: server.command!, args: server.args.map(fill), env: fillAll(server.env) }, secrets };
}

export function explainMcpError(error: unknown): { code: string; message: string } {
  if (error instanceof McpError) return { code: error.code, message: error.message };
  if (error instanceof SecretAccessError) return { code: 'secret_unavailable', message: `${error.message}. Grant it to this MCP server in Secrets.` };
  return { code: 'mcp_failed', message: error instanceof Error ? error.message : String(error) };
}

/** Connects, discovers tools, resources and prompts, and records what happened -- the "Test connection" button. */
export async function testMcpServer(
  db: Database,
  server: McpServerRecord,
  options: McpClientOptions,
): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: { code: string; message: string } }> {
  try {
    const { config } = await resolveTransport(db, server, options.fetchImpl);
    const discovery = await discoverMcpServer(config, options);
    recordDiscovery(db, server.id, discovery);
    return { ok: true, tools: discovery.tools };
  } catch (error) {
    const failure = explainMcpError(error);
    recordDiscovery(db, server.id, { error: failure.message, code: failure.code });
    return { ok: false, error: failure };
  }
}

const TRANSIENT = new Set(['timeout', 'unreachable', 'server_error']);
/** After this many failures in a row, calls fail fast for a while instead of each waiting out a timeout. */
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOL_DOWN_MS = 30_000;

/**
 * One tool call with the connection's resilience rules: a server that keeps
 * failing is not called again until it has had time to recover, a transient
 * failure of a call that is safe to repeat is retried once, and every outcome
 * moves the server's health.
 */
export async function callMcpServerTool(
  db: Database,
  server: McpServerRecord,
  tool: string,
  args: Record<string, unknown>,
  options: McpClientOptions & { idempotent?: boolean },
): Promise<{ text: string; isError: boolean; secrets: string[] }> {
  if (server.consecutiveFailures >= CIRCUIT_THRESHOLD && server.lastErrorAt && Date.now() - Date.parse(server.lastErrorAt) < CIRCUIT_COOL_DOWN_MS) {
    throw new McpError('circuit_open', `${server.name} failed ${server.consecutiveFailures} times in a row; Crewly will try it again shortly.`);
  }
  let secrets: string[] = [];
  for (let attempt = 1; ; attempt += 1) {
    try {
      const resolved = await resolveTransport(db, server, options.fetchImpl);
      secrets = resolved.secrets;
      const result = await callMcpTool(resolved.config, tool, args, options);
      recordCallOutcome(db, server.id, { ok: true });
      return { ...result, secrets };
    } catch (error) {
      const failure = explainMcpError(error);
      if (attempt === 1 && options.idempotent && TRANSIENT.has(failure.code)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      recordCallOutcome(db, server.id, { ok: false, error: failure.message, code: failure.code });
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), { secrets });
    }
  }
}

/**
 * Whether a header or env value is safe to show: it is, when everything in it
 * apart from secret references is empty or a bare auth scheme ("Bearer").
 * Anything else may be a pasted credential, so it is masked -- conservatively,
 * a harmless literal like `production` is masked too.
 */
function showable(value: string): boolean {
  const literal = value.replace(/\{\{\s*secret:[A-Z][A-Z0-9_]*\s*\}\}/g, '').trim();
  return literal === '' || /^(bearer|basic|token|bot)$/i.test(literal);
}

function redactValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, showable(value) ? value : REDACTED]));
}

export function publicMcpServer(server: McpServerRecord) {
  const { oauth, ...rest } = server;
  return {
    ...rest,
    headers: redactValues(server.headers),
    env: redactValues(server.env),
    // Whether it is signed in, never with what.
    oauth: oauth ? { signedIn: Boolean(oauth.accessToken), issuer: oauth.issuer ?? null, scope: oauth.scope ?? null, expiresAt: oauth.expiresAt ?? null } : null,
    status: !server.enabled ? 'disabled' : server.health === 'unknown' ? 'pending' : server.health,
    availableTools: server.tools.filter((tool) => !server.disabledTools.includes(tool.name)).map((tool) => tool.name),
  };
}

/** A PATCH that sends a masked value back means "keep what is there". */
export function mergeRedacted(incoming: Record<string, string> | undefined, existing: Record<string, string>): Record<string, string> | undefined {
  if (!incoming) return undefined;
  return Object.fromEntries(Object.entries(incoming).map(([key, value]) => [key, value === REDACTED ? existing[key] ?? '' : value]));
}

let registered = false;

/** Lets the secrets vault see which MCP servers refer to a secret, and name them. */
export function registerMcpSecretHooks(): void {
  if (registered) return;
  registered = true;
  registerSecretReferenceScanner((db, secretName) =>
    listMcpServers(db)
      .filter((server) =>
        [server.url ?? '', ...server.args, ...Object.values(server.headers), ...Object.values(server.env)]
          .some((value) => findSecretReferences(value).includes(secretName)))
      .map((server) => ({ type: 'mcp_server', id: server.id, name: server.name, via: 'reference' as const })));
  registerGranteeNamer('mcp_server', (db, id) => getMcpServer(db, id)?.name);
}
