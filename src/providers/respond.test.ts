import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { createProviderConfig } from './repository.js';
import { ProviderError, ProviderUnavailableError } from './errors.js';
import { createProviderRespond, MAX_TOOL_ROUNDS } from './respond.js';
import { RunCancelledError } from '../runtime/engine.js';

describe('createProviderRespond', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function freshSetup(modelPolicyExtra: { fallbackProviderId?: string; fallbackModel?: string } = {}) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-respond-'));
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

  it('throws when the primary provider is unavailable and no fallback is configured', async () => {
    const { db, agent } = freshSetup();
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-test' });
    const respond = createProviderRespond(
      db,
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch
    );

    // The caller turns this into an `agent.run.failed` event; a persisted
    // "[error] ..." message would read as something the agent said.
    await expect(
      respond({ agentId: agent.id, conversationId: 'conversation_1', recentMessages: [] })
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
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

  it('throws when both primary and fallback fail', async () => {
    const { db, agent } = freshSetup({ fallbackProviderId: 'backup', fallbackModel: 'model-b' });
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-bad' });
    createProviderConfig(db, { id: 'backup', kind: 'anthropic', apiKey: 'sk-also-bad' });
    const respond = createProviderRespond(
      db,
      (async () => {
        throw new Error('down');
      }) as unknown as typeof fetch
    );

    await expect(
      respond({ agentId: agent.id, conversationId: 'conversation_1', recentMessages: [] })
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    db.close();
  });

  it('throws when the agent does not exist', async () => {
    const { db } = freshSetup();
    const respond = createProviderRespond(db);
    await expect(
      respond({ agentId: 'nonexistent', conversationId: 'conversation_1', recentMessages: [] })
    ).rejects.toThrow(ProviderError);
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

  it('runs the tools the model asks for and gives it the results', async () => {
    const { db, agent } = freshSetup();
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-test' });
    const bodies: Array<{ messages: unknown[]; tools?: unknown[] }> = [];
    const replies = [
      { content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: { key: 'k' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      successBody,
    ];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return jsonResponse(replies.shift());
    }) as unknown as typeof fetch;
    const executed: unknown[] = [];
    const events: string[] = [];
    const respond = createProviderRespond(db, fetchImpl, undefined, {
      toolsets: [() => ({
        definitions: [{ name: 'lookup', description: 'Look a key up', inputSchema: { type: 'object' } }],
        execute: async (call) => {
          executed.push(call.input);
          return { content: 'value' };
        },
      })],
    });

    const result = await respond({
      agentId: agent.id, conversationId: 'conversation_1', recentMessages: [],
      onEvent: (event) => events.push(event.type),
    });

    expect(result.body).toBe('hi!');
    expect(executed).toEqual([{ key: 'k' }]);
    expect(bodies[1]!.messages).toContainEqual({
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'value' }],
    });
    expect(events).toEqual(['provider.call', 'tool.call', 'provider.call']);
    db.close();
  });

  it('stops offering tools once a model has used every round it gets', async () => {
    const { db, agent } = freshSetup();
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-test' });
    const offered: boolean[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { tools?: unknown[] };
      offered.push(Boolean(body.tools));
      return jsonResponse(body.tools
        ? { content: [{ type: 'tool_use', id: `t${offered.length}`, name: 'again', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }
        : successBody);
    }) as unknown as typeof fetch;
    const respond = createProviderRespond(db, fetchImpl, undefined, {
      toolsets: [() => ({
        definitions: [{ name: 'again', description: '', inputSchema: { type: 'object' } }],
        execute: async () => ({ content: 'more' }),
      })],
    });

    const result = await respond({ agentId: agent.id, conversationId: 'conversation_1', recentMessages: [] });
    expect(result.body).toBe('hi!');
    expect(offered).toEqual([...Array(MAX_TOOL_ROUNDS).fill(true), false]);
    db.close();
  });

  it('stops before the next model call once its run has been cancelled', async () => {
    const { db, agent } = freshSetup();
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-test' });
    let calls = 0;
    const respond = createProviderRespond(db, (async () => {
      calls += 1;
      return jsonResponse(successBody);
    }) as unknown as typeof fetch);

    await expect(respond({
      agentId: agent.id, conversationId: 'conversation_1', recentMessages: [], isCancelled: () => true,
    })).rejects.toBeInstanceOf(RunCancelledError);
    expect(calls).toBe(0);
    db.close();
  });
});

