import { describe, expect, it } from 'vitest';
import { AgentdBackedProviderClient } from './agentd.js';
import { ProviderUnavailableError } from './errors.js';
import { openSqlite } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { DeviceConnectionHub } from '../devices/hub.js';
import type { WebSocket } from 'ws';

function client(kind: 'claude-subscription' | 'ollama') {
  const db = openSqlite(':memory:');
  runMigrations(db);
  return { db, client: new AgentdBackedProviderClient(kind, kind, 'owner-1', db, new DeviceConnectionHub()) };
}

describe('AgentdBackedProviderClient', () => {
  it('rejects chat with ProviderUnavailableError, never a faked success', async () => {
    const created = client('claude-subscription');
    await expect(
      created.client.chat({ providerId: 'my-claude-subscription', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(ProviderUnavailableError);
    created.db.close();
  });

  it('routes chat through a connected device that advertises the provider', async () => {
    const db = openSqlite(':memory:');
    runMigrations(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (id, email, display_name, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('owner-1', 'owner@example.test', 'Owner', 'hash', 'owner', now);
    db.prepare(`INSERT INTO devices
      (id, owner_user_id, name, public_key, platform, capabilities, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'dev_0123456789abcdef0123', 'owner-1', 'Device', 'key', 'test',
      JSON.stringify({ providers: [{ kind: 'claude-subscription' }] }), now, now, now,
    );
    const hub = new DeviceConnectionHub();
    const socket = { OPEN: 1, readyState: 1, sent: [] as string[], send(value: string) { this.sent.push(value); }, close() {} };
    hub.connect('dev_0123456789abcdef0123', socket as unknown as WebSocket);
    const provider = new AgentdBackedProviderClient('claude-subscription', 'local', 'owner-1', db, hub);
    const pending = provider.chat({ providerId: 'local', model: 'claude', messages: [{ role: 'user', content: 'hi' }] });
    const outbound = JSON.parse(socket.sent[0]!) as { requestId: string };
    hub.handleResponse('dev_0123456789abcdef0123', { requestId: outbound.requestId, ok: true, result: { response: {
      providerId: 'local', model: 'claude', content: 'hello', stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    } } });
    await expect(pending).resolves.toMatchObject({ content: 'hello' });
    db.close();
  });

  it('rejects listModels with ProviderUnavailableError', async () => {
    const created = client('ollama');
    await expect(created.client.listModels()).rejects.toThrow(ProviderUnavailableError);
    created.db.close();
  });
});
