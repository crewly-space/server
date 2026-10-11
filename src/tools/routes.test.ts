import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createSession } from '../auth/session.js';
import { createAgent } from '../agents/repository.js';
import { createMcpServer, recordDiscovery } from '../mcp/repository.js';
import { buildToolCatalog } from './catalog.js';
import { evaluateToolPolicy, listToolPolicies, setToolPolicy, type SelectorType } from './policy.js';
import type { ToolPolicyMode } from './types.js';

describe('tool policy security', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let agentId: string;
  let ownerId: string;
  let ownerToken: string;
  let memberToken: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const owner = createUser(db, { email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    const member = createUser(db, { email: 'member@example.com', displayName: 'Member', passwordHash: 'x', role: 'member' });
    ownerId = owner.id;
    ownerToken = createSession(db, owner.id);
    memberToken = createSession(db, member.id);
    agentId = createAgent(db, { ownerUserId: member.id, name: 'Assistant', personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'test' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false } }).id;
    app = await buildApp({ db });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function replace(policies: { selectorType: SelectorType; selector: string; mode: ToolPolicyMode }[], token = memberToken) {
    return app.inject({ method: 'PUT', url: '/api/v1/tool-policies', headers: { authorization: `Bearer ${token}` },
      payload: { agentId, policies } });
  }

  it('cannot remove or weaken an existing block', async () => {
    setToolPolicy(db, { agentId, selectorType: 'tool', selector: 'test:read', mode: 'blocked', userId: ownerId });
    expect((await replace([])).statusCode).toBe(403);
    expect((await replace([{ selectorType: 'tool', selector: 'test:read', mode: 'ask_every_time' }])).statusCode).toBe(403);
    expect(listToolPolicies(db, agentId)[0]?.mode).toBe('blocked');
  });

  it('cannot override a broad block with a more specific rule or duplicate selectors', async () => {
    const blocked = { selectorType: 'risk' as const, selector: 'read', mode: 'blocked' as const };
    setToolPolicy(db, { agentId, ...blocked, userId: ownerId });
    expect((await replace([blocked, { selectorType: 'tool', selector: 'test:read', mode: 'ask_every_time' }])).statusCode).toBe(403);
    expect((await replace([blocked, { ...blocked, mode: 'always' }])).statusCode).toBe(403);
    expect(listToolPolicies(db, agentId)).toHaveLength(1);
  });

  it('allows tightening while preserving an existing admin exception', async () => {
    const blocked = { selectorType: 'risk' as const, selector: 'read', mode: 'blocked' as const };
    const exception = { selectorType: 'tool' as const, selector: 'test:read', mode: 'always' as const };
    for (const rule of [blocked, exception]) setToolPolicy(db, { agentId, ...rule, userId: ownerId });
    expect((await replace([blocked, exception, { selectorType: 'tool', selector: 'test:write', mode: 'blocked' }])).statusCode).toBe(200);
  });

  it('allows administrators to remove restrictions', async () => {
    setToolPolicy(db, { agentId, selectorType: 'risk', selector: 'read', mode: 'blocked', userId: ownerId });
    expect((await replace([], ownerToken)).statusCode).toBe(200);
    expect(listToolPolicies(db, agentId)).toHaveLength(0);
  });

  it('rolls back a rule that weakens a catalog tool default', async () => {
    const server = createMcpServer(db, { name: 'Admin tools', transport: 'http', url: 'https://example.com/mcp', ownerUserId: ownerId });
    recordDiscovery(db, server.id, { tools: [{ name: 'update_permissions', description: 'Administer permissions', inputSchema: { type: 'object' } }] });
    const tool = buildToolCatalog(db).find((candidate) => candidate.source.connectionId === server.id)!;
    expect(tool).toBeDefined();
    expect(evaluateToolPolicy(db, agentId, tool).mode).toBe('blocked');
    expect((await replace([{ selectorType: 'connection', selector: server.id, mode: 'ask_every_time' }])).statusCode).toBe(403);
    expect(listToolPolicies(db, agentId)).toHaveLength(0);
    expect(evaluateToolPolicy(db, agentId, tool).mode).toBe('blocked');
  });

  it('keeps DNS validation enabled for the production MCP transport', async () => {
    vi.stubEnv('CREWLY_ALLOW_PRIVATE_NETWORK', '');
    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await app.close();
    app = await buildApp({ db });
    const server = createMcpServer(db, { name: 'Loopback', transport: 'http', url: 'https://localhost:65533/mcp', ownerUserId: ownerId });
    const response = await app.inject({ method: 'POST', url: `/api/v1/mcp-servers/${server.id}/test`,
      headers: { authorization: `Bearer ${ownerToken}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
