import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { openSqlite } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createAgent } from '../agents/repository.js';
import { DeviceConnectionHub } from './hub.js';
import { getDevice } from './repository.js';
import { changeDeviceWorkspace } from './workspaces.js';

const DEVICE = 'dev_0123456789abcdef0123';
const OTHER = 'dev_ffffffffffffffffffff';

function setup() {
  const db = openSqlite(':memory:');
  runMigrations(db);
  const now = new Date().toISOString();
  const insertUser = db.prepare(`INSERT INTO users (id, email, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  insertUser.run('owner-1', 'owner@example.test', 'Owner', 'hash', 'owner', now);
  insertUser.run('other-1', 'other@example.test', 'Other', 'hash', 'member', now);
  const insertDevice = db.prepare(`INSERT INTO devices
    (id, owner_user_id, name, public_key, platform, capabilities, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertDevice.run(DEVICE, 'owner-1', 'Laptop', 'key', 'test', JSON.stringify({ workspaces: [{ id: 'ws_app', name: 'app' }] }), now, now, now);
  insertDevice.run(OTHER, 'other-1', 'Their laptop', 'key2', 'test', '{}', now, now, now);
  const hub = new DeviceConnectionHub();
  const socket = { OPEN: 1, readyState: 1, sent: [] as string[], send(value: string) { this.sent.push(value); }, close() {} };
  hub.connect(DEVICE, socket as unknown as WebSocket, ['agentd.capabilities.v1']);
  return { db, hub, socket };
}

async function answer(hub: DeviceConnectionHub, socket: { sent: string[] },
  response: { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const outbound = JSON.parse(socket.sent.at(-1)!) as { requestId: string; operation: string; payload: unknown };
  hub.handleResponse(DEVICE, { requestId: outbound.requestId, ...response });
  return outbound;
}

describe('managing a device’s workspaces from the app', () => {
  it('asks the device to add a folder and stores what it now shares', async () => {
    const { db, hub, socket } = setup();
    const pending = changeDeviceWorkspace(db, hub, 'owner-1', DEVICE, { action: 'add', path: '~/code/site', name: 'Site' });
    const sent = await answer(hub, socket, { ok: true, result: {
      workspace: { id: 'ws_site', name: 'Site' },
      capabilities: { workspaces: [{ id: 'ws_app', name: 'app' }, { id: 'ws_site', name: 'Site' }] },
    } });
    expect(sent).toMatchObject({ operation: 'workspace.add', payload: { path: '~/code/site', name: 'Site' } });
    expect(await pending).toEqual({ workspace: { id: 'ws_site', name: 'Site' }, workspaces: [{ id: 'ws_app', name: 'app' }, { id: 'ws_site', name: 'Site' }] });
    expect(JSON.parse(getDevice(db, DEVICE)!.capabilities).workspaces).toHaveLength(2);
    db.close();
  });

  it('carries a rename over to the agents bound to that workspace', async () => {
    const { db, hub, socket } = setup();
    const agent = createAgent(db, {
      ownerUserId: 'owner-1', name: 'Coder', personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-haiku-4-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    db.prepare(`INSERT INTO runtime_bindings (id, agent_id, runtime_kind, workspace_path, vendor_state, device_id, workspace_id, options, created_at, updated_at)
      VALUES ('b1', ?, 'claude-code', 'app', '{}', ?, 'ws_app', '{}', 'now', 'now')`).run(agent.id, DEVICE);
    const pending = changeDeviceWorkspace(db, hub, 'owner-1', DEVICE, { action: 'update', workspaceId: 'ws_app', name: 'Web app' });
    await answer(hub, socket, { ok: true, result: { workspace: { id: 'ws_app', name: 'Web app' }, capabilities: { workspaces: [{ id: 'ws_app', name: 'Web app' }] } } });
    await pending;
    expect(db.prepare('SELECT workspace_path FROM runtime_bindings WHERE id = ?').get('b1')).toEqual({ workspace_path: 'Web app' });
    db.close();
  });

  it('passes on the device’s refusal, and explains an outdated or offline device', async () => {
    const { db, hub, socket } = setup();
    const refused = changeDeviceWorkspace(db, hub, 'owner-1', DEVICE, { action: 'add', path: '/' });
    await answer(hub, socket, { ok: false, error: { code: 'workspace_invalid', message: 'Pick a project folder, not the whole disk' } });
    await expect(refused).rejects.toMatchObject({ status: 400, message: 'Pick a project folder, not the whole disk' });

    const outdated = changeDeviceWorkspace(db, hub, 'owner-1', DEVICE, { action: 'remove', workspaceId: 'ws_app' });
    await answer(hub, socket, { ok: false, error: { code: 'invalid_request', message: 'invalid device request' } });
    await expect(outdated).rejects.toMatchObject({ status: 409, code: 'device_outdated' });

    await expect(changeDeviceWorkspace(db, hub, 'other-1', OTHER, { action: 'remove', workspaceId: 'x' }))
      .rejects.toMatchObject({ status: 409, code: 'device_offline' });
    db.close();
  });

  it('never touches somebody else’s device', async () => {
    const { db, hub, socket } = setup();
    await expect(changeDeviceWorkspace(db, hub, 'other-1', DEVICE, { action: 'remove', workspaceId: 'ws_app' }))
      .rejects.toMatchObject({ status: 404 });
    expect(socket.sent).toHaveLength(0);
    db.close();
  });
});
