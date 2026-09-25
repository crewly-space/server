import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createProviderConfig } from '../providers/repository.js';
import { ProviderRequestError } from '../providers/errors.js';
import { AiGateway, withoutTools, type GatewayEvent, type GatewayRequest } from './gateway.js';
import { providerHealth } from './health.js';

const anthropicOk = (text = 'hi', headers: Record<string, string> = {}) =>
  new Response(
    JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }),
    { status: 200, headers },
  );

function scripted(...responses: Array<Response | Error>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('AiGateway', () => {
  let db: Database;
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    slept.length = 0;
    createProviderConfig(db, { id: 'primary', kind: 'anthropic', apiKey: 'sk-primary' });
    createProviderConfig(db, { id: 'backup', kind: 'openai', apiKey: 'sk-backup' });
  });

  afterEach(() => db.close());

  const request = (overrides: Partial<GatewayRequest> = {}, events?: GatewayEvent[]): GatewayRequest => ({
    target: { providerId: 'primary', model: 'claude-sonnet-5' },
    messages: [{ role: 'user', content: 'hello' }],
    context: { purpose: 'agent_turn', ownerUserId: 'owner', agentId: 'agent-1', runId: 'run-1', rootRunId: 'run-1', onEvent: (e) => events?.push(e) },
    ...overrides,
  });

  const meter = () =>
    db.prepare('SELECT provider_id, attempt, fallback, status, error_code, input_tokens, output_tokens, run_id FROM provider_calls ORDER BY rowid').all();

  it('retries a provider that could not be reached, and meters every attempt', async () => {
    const { fetchImpl } = scripted(new Error('ECONNRESET'), anthropicOk('answer'));
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    const events: GatewayEvent[] = [];

    const result = await gateway.chat(request({}, events));

    expect(result.content).toBe('answer');
    expect(result.attempts).toBe(2);
    expect(slept).toEqual([250]);
    expect(meter()).toEqual([
      { provider_id: 'primary', attempt: 1, fallback: 0, status: 'error', error_code: 'provider_unavailable', input_tokens: 0, output_tokens: 0, run_id: 'run-1' },
      { provider_id: 'primary', attempt: 2, fallback: 0, status: 'ok', error_code: null, input_tokens: 10, output_tokens: 5, run_id: 'run-1' },
    ]);
    expect(events.map((e) => e.type)).toEqual(['provider.call', 'provider.retry', 'provider.call']);
  });

  it('does not retry a rejected key', async () => {
    const { fetchImpl, calls } = scripted(new Response('{}', { status: 401 }));
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    await expect(gateway.chat(request())).rejects.toMatchObject({ code: 'provider_auth_failed' });
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('does not retry a request the provider refused, and says it was the request', async () => {
    const { fetchImpl, calls } = scripted(new Response('{}', { status: 404 }));
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    await expect(gateway.chat(request())).rejects.toBeInstanceOf(ProviderRequestError);
    expect(calls).toHaveLength(1);
  });

  it('waits out a short rate limit for as long as the provider asked', async () => {
    const { fetchImpl } = scripted(new Response('{}', { status: 429, headers: { 'retry-after': '2' } }), anthropicOk());
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    await gateway.chat(request());
    expect(slept).toEqual([2000]);
  });

  it('hands a long rate limit to the fallback instead of waiting a minute', async () => {
    const { fetchImpl, calls } = scripted(
      new Response('{}', { status: 429, headers: { 'retry-after': '60' } }),
      new Response(JSON.stringify({ choices: [{ message: { content: 'from backup' }, finish_reason: 'stop' }] }), { status: 200 }),
    );
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    const events: GatewayEvent[] = [];

    const result = await gateway.chat(request({ fallback: { providerId: 'backup', model: 'gpt-5' } }, events));

    expect(result.content).toBe('from backup');
    expect(result.usedFallback).toBe(true);
    expect(result.target).toEqual({ providerId: 'backup', model: 'gpt-5' });
    expect(slept).toEqual([]);
    expect(calls[1]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(events.find((e) => e.type === 'provider.fallback')).toMatchObject({ reason: 'provider_rate_limited' });
    expect(gateway.rateLimits.get('primary')?.limitedUntil).toBeDefined();
    expect(meter()).toMatchObject([{ fallback: 0, status: 'error' }, { fallback: 1, status: 'ok' }]);
  });

  it('falls back when the primary provider no longer exists', async () => {
    const { fetchImpl } = scripted(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 }),
    );
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    const result = await gateway.chat(
      request({ target: { providerId: 'deleted', model: 'x' }, fallback: { providerId: 'backup', model: 'gpt-5' } }),
    );
    expect(result.usedFallback).toBe(true);
  });

  it('lets a guard refuse a call before anything is spent', async () => {
    const { fetchImpl, calls } = scripted();
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    gateway.use(() => ({ action: 'block', error: new ProviderRequestError('over budget') }));
    const events: GatewayEvent[] = [];
    await expect(gateway.chat(request({}, events))).rejects.toThrow('over budget');
    expect(calls).toHaveLength(0);
    expect(events).toMatchObject([{ type: 'gateway.blocked', code: 'provider_bad_request' }]);
  });

  it('lets a guard send the call to the fallback instead', async () => {
    const { fetchImpl } = scripted(
      new Response(JSON.stringify({ choices: [{ message: { content: 'cheap' }, finish_reason: 'stop' }] }), { status: 200 }),
    );
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    gateway.use((_target, _context, { isFallback }) => (isFallback
      ? { action: 'allow' }
      : { action: 'fallback', reason: 'budget', error: new ProviderRequestError('no fallback') }));
    const result = await gateway.chat(request({ fallback: { providerId: 'backup', model: 'gpt-5-mini' } }));
    expect(result).toMatchObject({ content: 'cheap', usedFallback: true });
  });

  it('prices each call with the pricer it was given', async () => {
    const { fetchImpl } = scripted(anthropicOk());
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    gateway.setPricer((_kind, _model, usage) => usage.inputTokens * 3 + usage.outputTokens * 15);
    await gateway.chat(request());
    expect(db.prepare('SELECT cost_micros FROM provider_calls').get()).toEqual({ cost_micros: 105 });
  });

  it('remembers the rate limit a provider reports on a good answer', async () => {
    const { fetchImpl } = scripted(
      anthropicOk('hi', {
        'anthropic-ratelimit-requests-remaining': '41',
        'anthropic-ratelimit-tokens-remaining': '9000',
        'anthropic-ratelimit-requests-reset': '2026-09-22T12:00:00Z',
      }),
    );
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    await gateway.chat(request());
    expect(gateway.rateLimits.get('primary')).toMatchObject({
      requestsRemaining: 41,
      tokensRemaining: 9000,
      resetAt: '2026-09-22T12:00:00.000Z',
    });
  });

  it('sends tools in Anthropic’s shape and reads its tool calls back', async () => {
    const { fetchImpl, calls } = scripted(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      ),
    );
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    const result = await gateway.chat(
      request({
        messages: [
          { role: 'user', content: 'find x' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'tu_0', name: 'search', input: { q: 'w' } }] },
          { role: 'tool', toolCallId: 'tu_0', content: 'nothing' },
        ],
        tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      }),
    );
    expect(calls[0]!.body.tools).toEqual([{ name: 'search', description: 'Search', input_schema: { type: 'object' } }]);
    expect(calls[0]!.body.messages).toEqual([
      { role: 'user', content: 'find x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_0', name: 'search', input: { q: 'w' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_0', content: 'nothing' }] },
    ]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([{ id: 'tu_1', name: 'search', input: { q: 'x' } }]);
  });

  it('sends tools in OpenAI’s shape and reads its tool calls back', async () => {
    const { fetchImpl, calls } = scripted(
      new Response(
        JSON.stringify({
          choices: [{
            message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] },
            finish_reason: 'tool_calls',
          }],
        }),
        { status: 200 },
      ),
    );
    const gateway = new AiGateway({ db, fetchImpl, sleep });
    const result = await gateway.chat(
      request({
        target: { providerId: 'backup', model: 'gpt-5' },
        messages: [
          { role: 'user', content: 'find x' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'search', input: { q: 'w' } }] },
          { role: 'tool', toolCallId: 'c0', content: 'nothing' },
        ],
        tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      }),
    );
    expect(calls[0]!.body.tools).toEqual([
      { type: 'function', function: { name: 'search', description: 'Search', parameters: { type: 'object' } } },
    ]);
    expect(calls[0]!.body.messages).toEqual([
      { role: 'user', content: 'find x' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'search', arguments: '{"q":"w"}' } }] },
      { role: 'tool', tool_call_id: 'c0', content: 'nothing' },
    ]);
    expect(result).toMatchObject({ content: '', stopReason: 'tool_use', toolCalls: [{ id: 'c1', name: 'search', input: { q: 'x' } }] });
  });

  it('turns tool history into text for a provider that cannot take tools', () => {
    expect(
      withoutTools([
        { role: 'system', content: 'Only use assigned capabilities.' },
        { role: 'assistant', content: 'Checking', toolCalls: [{ id: 'a', name: 'search', input: { q: 1 } }] },
        { role: 'tool', toolCallId: 'a', content: 'boom', isError: true },
      ]),
    ).toEqual([
      { role: 'system', content: 'Only use assigned capabilities.\n\nTool execution is unavailable for this provider in this turn. Do not claim to have called a tool or completed an external action.' },
      { role: 'assistant', content: 'Checking\n[called search({"q":1})]' },
      { role: 'user', content: 'Tool result (error): boom' },
    ]);
  });
});

describe('providerHealth', () => {
  let db: Database;
  beforeEach(() => {
    db = openSqlite(':memory:');
    runMigrations(db);
  });
  afterEach(() => db.close());

  const call = (status: 'ok' | 'error', minutesAgo: number, errorCode: string | null = null) =>
    db.prepare(
      `INSERT INTO provider_calls (id, provider_id, provider_kind, model, purpose, attempt, status, error_code, latency_ms, created_at)
       VALUES (?, 'p', 'anthropic', 'm', 'agent_turn', 1, ?, ?, 100, ?)`,
    ).run(`${status}-${minutesAgo}`, status, errorCode, new Date(Date.now() - minutesAgo * 60_000).toISOString());

  const config = () => createProviderConfig(db, { id: 'p', kind: 'anthropic', apiKey: 'sk' });

  it('is unknown until something has been called', () => {
    expect(providerHealth(db, config()).status).toBe('unknown');
  });

  it('is healthy when calls succeed', () => {
    const provider = config();
    call('ok', 5);
    call('ok', 3);
    expect(providerHealth(db, provider)).toMatchObject({ status: 'healthy', window: { calls: 2, errors: 0, averageLatencyMs: 100 } });
  });

  it('is down after three failures in a row, and says which', () => {
    const provider = config();
    call('ok', 30);
    call('error', 3, 'provider_unavailable');
    call('error', 2, 'provider_unavailable');
    call('error', 1, 'provider_unavailable');
    expect(providerHealth(db, provider)).toMatchObject({ status: 'down', reason: 'The last 3 calls failed (provider_unavailable)' });
  });

  it('is down at once when the key is rejected', () => {
    const provider = config();
    call('error', 1, 'provider_auth_failed');
    expect(providerHealth(db, provider).status).toBe('down');
  });

  it('is degraded when more than a fifth of calls fail', () => {
    const provider = config();
    for (let i = 10; i > 1; i -= 1) call('ok', i);
    call('error', 11, 'provider_unavailable');
    call('error', 12, 'provider_unavailable');
    call('error', 13, 'provider_unavailable');
    expect(providerHealth(db, provider).status).toBe('degraded');
  });

  it('is down for a device-backed provider with no device connected', () => {
    const provider = createProviderConfig(db, { id: 'sub', kind: 'claude-subscription' });
    expect(providerHealth(db, provider)).toMatchObject({
      status: 'down',
      deviceConnected: false,
      reason: 'No paired device with Claude signed in is connected',
    });
  });
});
