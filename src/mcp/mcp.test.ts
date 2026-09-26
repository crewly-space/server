import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAgent } from '../agents/repository.js';
import { createSession } from '../auth/session.js';
import { createConversation } from '../conversations/repository.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { AiGateway } from '../gateway/gateway.js';
import { createProviderConfig } from '../providers/repository.js';
import { createSecret, setSecretGrants } from '../secrets/vault.js';
import { createUser } from '../users/repository.js';
import { callMcpTool, discoverMcpTools, McpError } from './client.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/echo-mcp.mjs');
const stdio = (env: Record<string, string> = {}) =>
  ({ transport: 'stdio' as const, command: process.execPath, args: [FIXTURE], env });

describe('MCP client over stdio', () => {
  it('discovers tools and calls one', async () => {
    const tools = await discoverMcpTools(stdio(), { allowStdio: true });
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'whoami']);
    expect(await callMcpTool(stdio(), 'echo', { text: 'hello' }, { allowStdio: true })).toEqual({ text: 'hello', isError: false });
  });

  it('gives the process only the environment it was configured with', async () => {
    process.env.HOME_SECRET = 'leaked';
    try {
      const result = await callMcpTool(stdio({ TOKEN: 't-1' }), 'whoami', {}, { allowStdio: true });
      expect(result.text).toBe('t-1 (no home secret)');
    } finally {
      delete process.env.HOME_SECRET;
    }
  });

  it('refuses to start local servers unless the operator allowed them', async () => {
    await expect(discoverMcpTools(stdio())).rejects.toMatchObject({ code: 'stdio_disabled' });
  });

  it('says a missing command is missing', async () => {
    await expect(discoverMcpTools({ transport: 'stdio', command: 'definitely-not-a-command-crewly', args: [], env: {} }, { allowStdio: true }))
      .rejects.toThrow('Command not found: definitely-not-a-command-crewly. Install it on the server or use its full path.');
  });
});

describe('MCP client over streamable HTTP', () => {
  function server(options: { status?: number } = {}) {
    const seen: Array<{ method: string; session: string | null; auth: string | null }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(String(init.body));
      seen.push({ method: body.method, session: headers.get('mcp-session-id'), auth: headers.get('authorization') });
      if (options.status) return new Response('{}', { status: options.status });
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }), {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
        });
      }
      if (body.method === 'tools/list') {
        // Answered as a server-sent event stream, with a notification first.
        const events = [
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}`,
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'search', description: 'Search issues', inputSchema: { type: 'object' } }] } })}`,
        ];
        return new Response(`${events.join('\n\n')}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'found 3' }] } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  const http = { transport: 'http' as const, url: 'https://mcp.example.com/mcp', headers: { authorization: 'Bearer t' } };

  it('initializes, keeps the session, and reads an SSE answer', async () => {
    const { fetchImpl, seen } = server();
    const tools = await discoverMcpTools(http, { fetchImpl });
    expect(tools).toEqual([{ name: 'search', description: 'Search issues', inputSchema: { type: 'object' } }]);
    expect(seen).toEqual([
      { method: 'initialize', session: null, auth: 'Bearer t' },
      { method: 'notifications/initialized', session: 'session-1', auth: 'Bearer t' },
      { method: 'tools/list', session: 'session-1', auth: 'Bearer t' },
    ]);
  });

  it('explains a refused credential', async () => {
    const { fetchImpl } = server({ status: 401 });
    const failure = await discoverMcpTools(http, { fetchImpl }).catch((error: McpError) => error);
    expect(failure).toMatchObject({
      code: 'unauthorized',
      message: 'The MCP server refused the credentials (401). Check the Authorization header or the secret it uses.',
    });
  });
});

describe('MCP routes and agent tools', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken: string;
  let memberToken: string;
  let memberAgentId: string;
  let replies: Response[];
  let sent: Array<{ tools?: Array<{ name: string }>; messages: Array<{ content: unknown }> }>;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    replies = [];
    sent = [];
    const owner = createUser(db, { email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'owner' });
    const member = createUser(db, { email: 'm@example.com', displayName: 'M', passwordHash: 'x', role: 'member' });
    ownerToken = createSession(db, owner.id);
    memberToken = createSession(db, member.id);
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'sk' });
    memberAgentId = createAgent(db, {
      ownerUserId: member.id,
      name: 'Helper',
      personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-haiku-4-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    }).id;
    const gateway = new AiGateway({
      db,
      sleep: async () => {},
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return replies.shift()!;
      }) as unknown as typeof fetch,
    });
    app = await buildApp({ db, gateway, allowMcpStdio: true });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const addEcho = (payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST', url: '/api/v1/mcp-servers', headers: as(ownerToken),
      payload: { name: 'Echo', transport: 'stdio', command: process.execPath, args: [FIXTURE], ...payload },
    });

  it('lets only admins connect servers', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/mcp-servers', headers: as(memberToken),
      payload: { name: 'x', transport: 'http', url: 'https://x.example.com/mcp' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('masks a pasted credential but shows a secret reference, and keeps the value when the mask comes back', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/mcp-servers', headers: as(ownerToken),
      payload: {
        name: 'GitHub', transport: 'http', url: 'https://mcp.example.com/mcp',
        headers: { authorization: 'Bearer ghp_pasted_literal', 'x-api-key': '{{secret:GH_KEY}}' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().headers).toEqual({ authorization: '••••••', 'x-api-key': '{{secret:GH_KEY}}' });
    expect(created.body).not.toContain('ghp_pasted_literal');

    const patched = await app.inject({
      method: 'PATCH', url: `/api/v1/mcp-servers/${created.json().id}`, headers: as(ownerToken),
      payload: { headers: { authorization: '••••••', 'x-api-key': '{{secret:GH_KEY}}' } },
    });
    expect(patched.statusCode).toBe(200);
    const stored = db.prepare('SELECT headers FROM mcp_servers').pluck().get() as string;
    expect(stored).toMatch(/^enc:v1:/);
  });

  it('tests a connection and records the tools it found, or why it could not', async () => {
    const created = await addEcho();
    const tested = await app.inject({ method: 'POST', url: `/api/v1/mcp-servers/${created.json().id}/test`, headers: as(ownerToken) });
    expect(tested.json()).toMatchObject({ ok: true, server: { availableTools: ['echo', 'whoami'], lastError: null } });

    const broken = await addEcho({ name: 'Broken', command: 'definitely-not-a-command-crewly' });
    const failed = await app.inject({ method: 'POST', url: `/api/v1/mcp-servers/${broken.json().id}/test`, headers: as(ownerToken) });
    expect(failed.json()).toMatchObject({ ok: false, error: { code: 'command_not_found' } });
    expect(failed.json().server.lastError).toMatch(/^Command not found/);
  });

  it('makes an admin acknowledge what a server can do before an agent gets its tools', async () => {
    const created = await addEcho({ capabilities: ['shell'] });
    const id = created.json().id;
    await app.inject({ method: 'POST', url: `/api/v1/mcp-servers/${id}/test`, headers: as(ownerToken) });

    const byOwner = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${memberAgentId}/tools`, headers: as(memberToken),
      payload: { tools: [{ serverId: id, toolName: 'echo' }], acknowledgeCapabilities: ['shell'] },
    });
    expect(byOwner.statusCode).toBe(403);

    const unacknowledged = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${memberAgentId}/tools`, headers: as(ownerToken),
      payload: { tools: [{ serverId: id, toolName: 'echo' }] },
    });
    expect(unacknowledged.json()).toMatchObject({ error: 'capabilities_not_acknowledged', capabilities: ['shell'] });

    const granted = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${memberAgentId}/tools`, headers: as(ownerToken),
      payload: { tools: [{ serverId: id, toolName: 'echo' }], acknowledgeCapabilities: ['shell'] },
    });
    expect(granted.json().tools).toEqual([{ serverId: id, serverName: 'Echo', toolName: 'echo', grantedCapabilities: ['shell'] }]);
  });

  it('lets an agent owner give it tools from a server that declares nothing dangerous', async () => {
    const id = (await addEcho()).json().id;
    await app.inject({ method: 'POST', url: `/api/v1/mcp-servers/${id}/test`, headers: as(ownerToken) });
    const unknown = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${memberAgentId}/tools`, headers: as(memberToken),
      payload: { tools: [{ serverId: id, toolName: 'nope' }] },
    });
    expect(unknown.statusCode).toBe(400);
    const granted = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${memberAgentId}/tools`, headers: as(memberToken),
      payload: { tools: [{ serverId: id, toolName: 'echo' }] },
    });
    expect(granted.statusCode).toBe(200);
  });

  it('puts an assigned tool in front of the model and runs it, with its secret filled in', async () => {
    const secret = createSecret(db, { name: 'ECHO_TOKEN', value: 'tok-from-vault' }, { type: 'system', id: null });
    const id = (await addEcho({ env: { TOKEN: '{{secret:ECHO_TOKEN}}' } })).json().id;
    setSecretGrants(db, secret.id, [{ type: 'mcp_server', id }], { type: 'system', id: null });
    await app.inject({ method: 'POST', url: `/api/v1/mcp-servers/${id}/test`, headers: as(ownerToken) });
    await app.inject({
      method: 'PUT', url: `/api/v1/agents/${memberAgentId}/tools`, headers: as(memberToken),
      payload: { tools: [{ serverId: id, toolName: 'whoami' }] },
    });

    replies.push(
      new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 't1', name: 'mcp_echo_whoami', input: {} }],
        stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
      })),
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })),
    );
    const conversation = createConversation(db, {
      kind: 'dm', name: null,
      participants: [
        { participantId: db.prepare("SELECT id FROM users WHERE role = 'member'").pluck().get() as string, participantType: 'user' },
        { participantId: memberAgentId, participantType: 'agent' },
      ],
    });
    await app.inject({
      method: 'POST', url: `/api/v1/conversations/${conversation.id}/messages`, headers: as(memberToken), payload: { body: 'who are you?' },
    });
    for (let i = 0; i < 200 && sent.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent[0]!.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(['mcp_echo_whoami', 'create_artifact']));
    expect(JSON.stringify(sent[1]!.messages.at(-1))).toContain('tok-from-vault');
    // The vault knows who read it.
    expect(db.prepare("SELECT actor_type FROM secret_audit WHERE action = 'accessed'").pluck().all()).toContain('mcp_server');

    // And deleting the secret now names the server that refers to it.
    const refused = await app.inject({ method: 'DELETE', url: `/api/v1/secrets/${secret.id}`, headers: as(ownerToken) });
    expect(refused.json().dependents).toContainEqual({ type: 'mcp_server', id, name: 'Echo', via: 'reference' });
  });
});
