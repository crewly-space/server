import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAgent } from '../agents/repository.js';
import { createSession } from '../auth/session.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createProviderConfig } from '../providers/repository.js';
import { createUser } from '../users/repository.js';

describe('agent runtime', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken: string;
  let otherToken: string;
  let agentId: string;
  let ownerId: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db });
    ownerId = createUser(db, { email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'member' }).id;
    ownerToken = createSession(db, ownerId);
    otherToken = createSession(db, createUser(db, { email: 'x@example.com', displayName: 'X', passwordHash: 'x', role: 'member' }).id);
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'sk' });
    agentId = createAgent(db, {
      ownerUserId: ownerId,
      name: 'Coder',
      personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-haiku-4-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    }).id;
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const pairDevice = (capabilities: Record<string, unknown>) =>
    db.prepare(
      `INSERT INTO devices (id, owner_user_id, name, public_key, capabilities, created_at, updated_at)
       VALUES ('dev_1', ?, 'Laptop', 'key', ?, 'now', 'now')`,
    ).run(ownerId, JSON.stringify(capabilities));
  const put = (payload: Record<string, unknown>, token = ownerToken) =>
    app.inject({ method: 'PUT', url: `/api/v1/agents/${agentId}/runtime`, headers: as(token), payload });

  it('starts on the native runtime, which is always available', async () => {
    const view = await app.inject({ method: 'GET', url: `/api/v1/agents/${agentId}/runtime`, headers: as(ownerToken) });
    expect(view.json()).toMatchObject({ runtimeKind: 'native', binding: null, health: { available: true }, sessions: [], devices: [] });
  });

  it('binds a coding runtime to a device and one of its workspaces, and says why it cannot run yet', async () => {
    pairDevice({
      runtimes: [{ id: 'claude-code', name: 'Claude Code', authenticated: true }],
      workspaces: [{ id: 'ws_app', name: 'app' }],
    });
    const bound = await put({ runtimeKind: 'claude-code', deviceId: 'dev_1', workspaceId: 'ws_app', options: { permissionMode: 'auto_edit' } });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toMatchObject({
      runtimeKind: 'claude-code',
      binding: { deviceId: 'dev_1', deviceName: 'Laptop', workspaceId: 'ws_app', workspaceName: 'app', options: { permissionMode: 'auto_edit' } },
      // Paired and set up, but not connected right now.
      health: { available: false, reason: 'Laptop is offline' },
      devices: [{ id: 'dev_1', runtimes: [{ id: 'claude-code', authenticated: true }], workspaces: [{ id: 'ws_app', name: 'app' }] }],
    });
    // The agent's canonical status agrees.
    const status = await app.inject({ method: 'GET', url: `/api/v1/agents/${agentId}/status`, headers: as(ownerToken) });
    expect(status.json()).toMatchObject({ execution: 'runtime_unavailable', reason: 'Laptop is offline' });
  });

  it('explains what is missing on the device', async () => {
    pairDevice({ runtimes: [{ id: 'codex', authenticated: false }], workspaces: [] });
    expect((await put({ runtimeKind: 'claude-code', deviceId: 'dev_1', workspaceId: 'x' })).json().message)
      .toBe('Claude Code is not installed on Laptop. Run `crewly runtime install` there.');
    expect((await put({ runtimeKind: 'codex', deviceId: 'dev_1', workspaceId: 'x' })).json().message)
      .toBe("Choose one of Laptop's workspaces. Add one there with `crewly workspace add <path>`.");
    expect((await put({ runtimeKind: 'codex' })).json().message).toBe('Codex runs on a paired device: choose one');
  });

  it('accepts only the runtime options it knows', async () => {
    const response = await put({ runtimeKind: 'native', options: { permissionMode: 'ask', vendorSessionId: 'x' } });
    expect(response.statusCode).toBe(400);
  });

  it('lets only the agent owner change its runtime', async () => {
    expect((await put({ runtimeKind: 'native' }, otherToken)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/agents/${agentId}/runtime`, headers: as(otherToken) })).statusCode).toBe(403);
  });
});
