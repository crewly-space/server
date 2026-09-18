import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { createProviderConfig } from './repository.js';
import { createProviderRespond } from './respond.js';

describe('createProviderRespond', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshSetup(modelPolicyExtra: { fallbackProviderId?: string; fallbackModel?: string } = {}) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencrew-respond-'));
    const db = openDatabase(dataDir);
    runMigrations(db);
    const owner = createUser(db, { email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    const agent = createAgent(db, {
      ownerUserId: owner.id,
      name: 'Assistant',
      personality: '',
      modelPolicy: { defaultProviderId: 'primary', defaultModel: 'model-a', ...modelPolicyExtra },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    return { db, owner, agent };
  }

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status });
  }

  const successBody = { content: [{ type: 'text', text: 'hi!' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };

  it('returns the provider response body on success', async () => {
    const { db, agent } = freshSetup();
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-test' });
    const respond = createProviderRespond(db, (async () => jsonResponse(successBody)) as unknown as typeof fetch);

    const result = await respond({ agentId: agent.id, conversationId: 'conversation_1', recentMessages: [] });
    expect(result.body).toBe('hi!');
    db.close();
  });

  it('returns a safe error message when the primary provider is unavailable and no fallback is configured', async () => {
    const { db, agent } = freshSetup();
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-test' });
    const respond = createProviderRespond(
      db,
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch
    );

    const result = await respond({ agentId: agent.id, conversationId: 'conversation_1', recentMessages: [] });
    expect(result.body).toContain('could not respond right now');
    db.close();
  });

  it('falls back to the fallback provider when the primary fails', async () => {
    const { db, agent } = freshSetup({ fallbackProviderId: 'backup', fallbackModel: 'model-b' });
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-bad' });
    createProviderConfig(db, { id: 'backup', kind: 'anthropic', apiKey: 'sk-good' });
    let callCount = 0;
    const fakeFetch = (async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('primary down');
      return jsonResponse({ content: [{ type: 'text', text: 'fallback here' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    }) as unknown as typeof fetch;
    const respond = createProviderRespond(db, fakeFetch);

    const result = await respond({ agentId: agent.id, conversationId: 'conversation_1', recentMessages: [] });
    expect(result.body).toBe('fallback here');
    expect(callCount).toBe(2);
    db.close();
  });

  it('returns a safe error message when both primary and fallback fail', async () => {
    const { db, agent } = freshSetup({ fallbackProviderId: 'backup', fallbackModel: 'model-b' });
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-bad' });
    createProviderConfig(db, { id: 'backup', kind: 'anthropic', apiKey: 'sk-also-bad' });
    const respond = createProviderRespond(
      db,
      (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch
    );

    const result = await respond({ agentId: agent.id, conversationId: 'conversation_1', recentMessages: [] });
    expect(result.body).toContain('could not respond right now');
    db.close();
  });

  it('returns a safe error message when the agent does not exist', async () => {
    const { db } = freshSetup();
    const respond = createProviderRespond(db);
    const result = await respond({ agentId: 'nonexistent', conversationId: 'conversation_1', recentMessages: [] });
    expect(result.body).toContain('not found');
    db.close();
  });

  it('propagates a genuinely unexpected error instead of swallowing it', async () => {
    const { db, owner } = freshSetup();
    const agentWithBrokenProvider = createAgent(db, {
      ownerUserId: owner.id,
      name: 'Broken',
      personality: '',
      modelPolicy: { defaultProviderId: 'broken', defaultModel: 'model-a' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    createProviderConfig(db, { id: 'broken', kind: 'anthropic', apiKey: null });
    const respond = createProviderRespond(db);

    await expect(
      respond({ agentId: agentWithBrokenProvider.id, conversationId: 'conversation_1', recentMessages: [] })
    ).rejects.toThrow(/missing an apiKey/);
    db.close();
  });
});
