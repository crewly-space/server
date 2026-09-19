import { openSqlite, type Database } from '../src/db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createProviderConfig } from '../src/providers/repository.js';
import { createProviderRespond } from '../src/providers/respond.js';

describe('provider end-to-end: real request shape through a configured provider, and reported failure', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  async function setupAgentAndConversation(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    const token = setup.json().token as string;

    const createAgent = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Assistant', modelPolicy: { defaultProviderId: 'anthropic-default', defaultModel: 'claude-sonnet-5' } },
    });
    const agentId = createAgent.json().id as string;

    const dm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: agentId, participantType: 'agent' },
    });

    return { token, agentId, conversationId: dm.json().id as string };
  }

  it('invokes an agent whose response comes from a real provider request/response round-trip', async () => {
    createProviderConfig(db, { id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-test' });
    let capturedBody: { model: string } | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Real provider response!' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 3 },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const app = await buildApp({ db, respond: createProviderRespond(db, fakeFetch) });
    const { token, agentId, conversationId } = await setupAgentAndConversation(app);

    const invoke = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/runs`,
      headers: { authorization: `Bearer ${token}` },
      payload: { conversationId },
    });
    expect(invoke.statusCode).toBe(201);
    expect(invoke.json().message.body).toBe('Real provider response!');
    expect(capturedBody?.model).toBe('claude-sonnet-5');

    await app.close();
  });

  it('reports an unreachable provider as a 502 instead of a message the agent appears to have spoken', async () => {
    createProviderConfig(db, { id: 'anthropic-default', kind: 'anthropic', apiKey: 'sk-test' });
    const fakeFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const app = await buildApp({ db, respond: createProviderRespond(db, fakeFetch) });
    const { token, agentId, conversationId } = await setupAgentAndConversation(app);

    const invoke = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${agentId}/runs`,
      headers: { authorization: `Bearer ${token}` },
      payload: { conversationId },
    });
    expect(invoke.statusCode).toBe(502);
    expect(invoke.json().error).toBe('provider_unavailable');
    expect(invoke.json().message).toContain('Assistant could not reply');

    // Nothing is persisted: an "[error] ..." line in the transcript reads as
    // the agent's own words and outlives the failure it describes.
    const messages = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(messages.json()).toHaveLength(0);

    await app.close();
  });
});
