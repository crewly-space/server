import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createMcpServer, getMcpServer, recordCallOutcome, saveMcpOAuth } from './repository.js';
import { callMcpServerTool } from './service.js';
import { mcpAccessToken } from './oauth.js';

describe('MCP connection health and resilience', () => {
  let db: Database;
  let requests: Array<{ url: string; auth: string | null; method: string }>;
  let failWith: number | null;
  let failures: number;

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (url.endsWith('/token')) {
      const form = new URLSearchParams(String(init.body));
      requests.push({ url, auth: null, method: form.get('grant_type')! });
      if (form.get('refresh_token') === 'dead') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      return new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    const body = JSON.parse(String(init.body));
    requests.push({ url, auth: headers.get('authorization'), method: body.method });
    if (failWith && failures > 0 && body.method === 'tools/call') { failures -= 1; return new Response('{}', { status: failWith }); }
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : { content: [{ type: 'text', text: 'ok' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  beforeEach(() => {
    db = openSqlite(':memory:');
    runMigrations(db);
    requests = [];
    failWith = null;
    failures = 0;
  });
  afterEach(() => db.close());

  const server = () => createMcpServer(db, { name: 'Remote', transport: 'http', url: 'https://mcp.example.com/mcp' });

  it('moves from connected to degraded to error, and back on success', () => {
    const { id } = server();
    recordCallOutcome(db, id, { ok: true });
    expect(getMcpServer(db, id)!.health).toBe('connected');
    recordCallOutcome(db, id, { ok: false, error: 'timed out', code: 'timeout' });
    expect(getMcpServer(db, id)).toMatchObject({ health: 'degraded', consecutiveFailures: 1, lastError: 'timed out' });
    recordCallOutcome(db, id, { ok: false, error: 'x' });
    recordCallOutcome(db, id, { ok: false, error: 'x' });
    expect(getMcpServer(db, id)!.health).toBe('error');
    recordCallOutcome(db, id, { ok: false, error: 'refused', code: 'unauthorized' });
    expect(getMcpServer(db, id)!.health).toBe('expired');
    recordCallOutcome(db, id, { ok: true });
    expect(getMcpServer(db, id)).toMatchObject({ health: 'connected', consecutiveFailures: 0, lastError: null });
  });

  it('retries a transient failure of a read once, but never a write', async () => {
    const { id } = server();
    failWith = 503;
    failures = 1;
    await expect(callMcpServerTool(db, getMcpServer(db, id)!, 'list', {}, { fetchImpl, idempotent: true })).resolves.toMatchObject({ text: 'ok' });
    failures = 1;
    await expect(callMcpServerTool(db, getMcpServer(db, id)!, 'create', {}, { fetchImpl, idempotent: false })).rejects.toMatchObject({ code: 'server_error' });
    expect(requests.filter((request) => request.method === 'tools/call')).toHaveLength(3);
    expect(getMcpServer(db, id)!.health).toBe('degraded');
  });

  it('stops calling a server that keeps failing until it has had time to recover', async () => {
    const { id } = server();
    for (let i = 0; i < 5; i += 1) recordCallOutcome(db, id, { ok: false, error: 'down', code: 'unreachable' });
    const before = requests.length;
    await expect(callMcpServerTool(db, getMcpServer(db, id)!, 'list', {}, { fetchImpl })).rejects.toMatchObject({ code: 'circuit_open' });
    expect(requests.length).toBe(before);
  });

  it('renews an OAuth token about to expire, and says so when it cannot', async () => {
    const { id } = server();
    const oauth = { authorizationEndpoint: 'https://auth.example.com/authorize', tokenEndpoint: 'https://auth.example.com/token', resource: 'https://mcp.example.com/mcp', clientId: 'c' };
    saveMcpOAuth(db, id, { ...oauth, accessToken: 'still-good', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(await mcpAccessToken(db, getMcpServer(db, id)!, fetchImpl)).toBe('still-good');

    saveMcpOAuth(db, id, { ...oauth, accessToken: 'stale', refreshToken: 'r1', expiresAt: new Date(Date.now() + 5_000).toISOString() });
    await callMcpServerTool(db, getMcpServer(db, id)!, 'list', {}, { fetchImpl });
    expect(requests.find((request) => request.method === 'tools/call')!.auth).toBe('Bearer fresh-token');
    expect(getMcpServer(db, id)!.oauth).toMatchObject({ accessToken: 'fresh-token', refreshToken: 'r1' });

    saveMcpOAuth(db, id, { ...oauth, accessToken: 'stale', refreshToken: 'dead', expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await expect(callMcpServerTool(db, getMcpServer(db, id)!, 'list', {}, { fetchImpl })).rejects.toMatchObject({ code: 'oauth_expired' });
    expect(getMcpServer(db, id)!.health).toBe('expired');
  });

  it('keeps OAuth tokens encrypted at rest', () => {
    const { id } = server();
    saveMcpOAuth(db, id, { authorizationEndpoint: 'a', tokenEndpoint: 't', resource: 'r', clientId: 'c', accessToken: 'plain-access-token' });
    expect(String(db.prepare('SELECT oauth FROM mcp_servers WHERE id = ?').pluck().get(id))).not.toContain('plain-access-token');
  });
});
