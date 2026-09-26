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
    expect((bodies[0] as { tools?: Array<{ name: string }> }).tools?.map((tool) => tool.name)).toEqual(['lookup']);
    expect(JSON.stringify(bodies[0])).toMatch(/Capability grounding/);
    expect(bodies[1]!.messages).toContainEqual({
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'value' }],
    });
    expect(events).toEqual(['provider.call', 'tool.call', 'provider.call']);
    db.close();
  });

  it('grounds a no-tool run instead of describing ambient web access', async () => {
    const { db, agent } = freshSetup();
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-test' });
    let body: Record<string, unknown> | undefined;
    const respond = createProviderRespond(db, (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse(successBody);
    }) as unknown as typeof fetch);

    await respond({ agentId: agent.id, conversationId: 'conversation_1', recentMessages: [] });

    expect(body?.tools).toBeUndefined();
    expect(String(body?.system)).toMatch(/no callable tools/i);
    expect(String(body?.system)).toMatch(/cannot browse the web/i);
    db.close();
  });

  it('keeps a failed tool result marked as a failure for the next model turn', async () => {
    const { db, agent } = freshSetup();
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-test' });
    const replies = [
      { content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      successBody,
    ];
    const bodies: Array<{ messages: unknown[] }> = [];
    const respond = createProviderRespond(db, (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as { messages: unknown[] });
      return jsonResponse(replies.shift());
    }) as unknown as typeof fetch, undefined, {
      toolsets: [() => ({
        definitions: [{ name: 'lookup', description: 'Look a key up', inputSchema: { type: 'object' } }],
        execute: async () => ({ content: 'network unavailable', isError: true }),
      })],
    });

    await respond({ agentId: agent.id, conversationId: 'conversation_1', recentMessages: [] });

    expect(JSON.stringify(bodies[1])).toMatch(/network unavailable/);
    expect(JSON.stringify(bodies[1])).toMatch(/is_error/);
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

  describe('grounding the agent in the tools it really has (CRE-107)', () => {
    const captureSystem = (bodies: Array<{ system?: string; tools?: unknown[] }>, replies: unknown[]) =>
      (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse(replies.shift() ?? successBody);
      }) as unknown as typeof fetch;

    it('tells an agent with no tools that it cannot browse, and offers it none', async () => {
      const { db, agent } = freshSetup();
      createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-test' });
      const bodies: Array<{ system?: string; tools?: unknown[] }> = [];
      await createProviderRespond(db, captureSystem(bodies, []))({ agentId: agent.id, conversationId: 'c', recentMessages: [] });
      expect(bodies[0]!.tools).toBeUndefined();
      expect(bodies[0]!.system).toContain('you have no tools');
      expect(bodies[0]!.system).toContain('cannot browse the web');
      expect(bodies[0]!.system).toMatch(/current date and time is \d{4}-\d{2}-\d{2}T/);
      db.close();
    });

    it('lists exactly the tools this run offers, and no global ones', async () => {
      const { db, agent } = freshSetup();
      createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-test' });
      const bodies: Array<{ system?: string; tools?: Array<{ name: string }> }> = [];
      const respond = createProviderRespond(db, captureSystem(bodies, []), undefined, {
        toolsets: [
          () => ({
            definitions: [{ name: 'github__search_issues', description: 'Search issues in a repository.\nMore detail.', inputSchema: { type: 'object' } }],
            execute: async () => ({ content: '[]' }),
          }),
          // A provider with nothing for this agent contributes nothing, not an empty mention.
          () => undefined,
        ],
      });
      await respond({ agentId: agent.id, conversationId: 'c', recentMessages: [] });
      expect(bodies[0]!.tools!.map((tool) => tool.name)).toEqual(['github__search_issues']);
      expect(bodies[0]!.system).toContain('exactly this tool, and no others');
      expect(bodies[0]!.system).toContain('- github__search_issues: Search issues in a repository.');
      expect(bodies[0]!.system).not.toContain('More detail.');
      expect(bodies[0]!.system).not.toContain('you have no tools');
      db.close();
    });

    it('hands a failed tool call back as a failure the model cannot mistake for a result', async () => {
      const { db, agent } = freshSetup();
      createProviderConfig(db, { id: 'primary', kind: 'openai', apiKey: 'sk-test' });
      const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
      const replies = [
        { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://time.is"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [{ message: { content: 'I could not load that page.' }, finish_reason: 'stop' }] },
      ];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse(replies.shift());
      }) as unknown as typeof fetch;
      const traced: Array<{ type: string; status?: string }> = [];
      const respond = createProviderRespond(db, fetchImpl, undefined, {
        toolsets: [() => ({
          definitions: [{ name: 'fetch_page', description: 'Fetch a web page.', inputSchema: { type: 'object' } }],
          execute: async () => { throw new Error('network egress denied by policy'); },
        })],
      });
      const result = await respond({
        agentId: agent.id, conversationId: 'c', recentMessages: [],
        onEvent: (event) => traced.push(event as { type: string; status?: string }),
      });
      expect(result.body).toBe('I could not load that page.');
      const toolMessage = bodies[1]!.messages.find((message) => message.role === 'tool')!;
      expect(toolMessage.content).toMatch(/^\[tool call failed\] The tool failed: network egress denied by policy/);
      // The trace records the call that actually happened, and that it failed.
      expect(traced.filter((event) => event.type === 'tool.call')).toEqual([expect.objectContaining({ status: 'error' })]);
      db.close();
    });

    it('offers no tools, and describes none, to a provider that cannot take them', async () => {
      const { db, agent } = freshSetup();
      createProviderConfig(db, { id: 'primary', kind: 'ollama' });
      let asked = false;
      const respond = createProviderRespond(db, (async () => jsonResponse(successBody)) as unknown as typeof fetch, undefined, {
        toolsets: [() => {
          asked = true;
          return { definitions: [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object' } }], execute: async () => ({ content: '' }) };
        }],
      });
      // No paired device here, so the call itself fails; what matters is what it would have been told.
      await expect(respond({ agentId: agent.id, conversationId: 'c', recentMessages: [] })).rejects.toThrow();
      expect(asked).toBe(false);
      db.close();
    });
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
