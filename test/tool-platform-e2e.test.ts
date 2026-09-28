import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createAgent } from '../src/agents/repository.js';
import { createSession } from '../src/auth/session.js';
import { createConversation } from '../src/conversations/repository.js';
import { openSqlite, type Database } from '../src/db/driver.js';
import { runMigrations } from '../src/db/migrate.js';
import { AiGateway } from '../src/gateway/gateway.js';
import { createProviderConfig } from '../src/providers/repository.js';
import { createSecret, setSecretGrants } from '../src/secrets/vault.js';
import { createUser } from '../src/users/repository.js';

/**
 * The foundation's definition of done, end to end:
 *
 *   connect GitHub (token), Sentry and Vercel (OAuth) through MCP -> tools
 *   discovered and normalized -> install Production Bug Fixer -> see and
 *   authorize its permissions -> an agent fixes a Sentry issue through a PR
 *   and a preview -> asks before merging -> a person approves -> Crewly runs
 *   the merge -> every call is in the audit log -> no credential ever
 *   reached the model.
 */

const GITHUB_TOKEN = 'ghp_realGitHubTokenThatMustNeverLeak0001';
const SENTRY_ACCESS = 'sentry-access-token-must-never-leak';
const VERCEL_ACCESS = 'vercel-access-token-must-never-leak';

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> };

interface FakeServer {
  url: string;
  token: string;
  tools: Tool[];
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  oauth?: { issuer: string; code: string };
  resources?: Array<{ uri: string; name: string }>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = { type: 'string' };

function world() {
  const github: FakeServer = {
    url: 'https://api.githubcopilot.com/mcp/', token: GITHUB_TOKEN, calls: [],
    tools: [
      { name: 'get_file_contents', description: 'Get a file', inputSchema: obj({ owner: str, repo: str, path: str }, ['path']), annotations: { readOnlyHint: true } },
      { name: 'create_branch', description: 'Create a branch', inputSchema: obj({ repo: str, branch: str }, ['branch']) },
      { name: 'push_files', description: 'Commit files', inputSchema: obj({ repo: str, branch: str, files: { type: 'array' }, message: str }) },
      { name: 'create_pull_request', description: 'Open a pull request', inputSchema: obj({ repo: str, head: str, base: str, title: str, body: str }) },
      { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: obj({ repo: str, pullNumber: { type: 'number' } }, ['pullNumber']) },
      { name: 'delete_repository', description: 'Delete a repository', inputSchema: obj({ repo: str }) },
    ],
  };
  const sentry: FakeServer = {
    url: 'https://mcp.sentry.dev/mcp', token: SENTRY_ACCESS, calls: [], oauth: { issuer: 'https://mcp.sentry.dev', code: 'sentry-code' },
    resources: [{ uri: 'sentry://docs/query-syntax', name: 'Query syntax' }],
    tools: [
      { name: 'search_issues', description: 'Search issues', inputSchema: obj({ query: str }) },
      { name: 'get_issue_details', description: 'Get an issue with its stack trace', inputSchema: obj({ issueId: str }, ['issueId']) },
    ],
  };
  const vercel: FakeServer = {
    url: 'https://mcp.vercel.com/', token: VERCEL_ACCESS, calls: [], oauth: { issuer: 'https://vercel.com', code: 'vercel-code' },
    tools: [
      { name: 'get_deployment', description: 'Get a deployment', inputSchema: obj({ id: str }) },
      { name: 'deploy_to_vercel', description: 'Deploy a branch as a preview', inputSchema: obj({ project: str, branch: str }) },
      { name: 'promote_deployment', description: 'Promote to production', inputSchema: obj({ id: str }) },
    ],
  };
  const servers = [github, sentry, vercel];
  const registrations: string[] = [];
  const tokenRequests: URLSearchParams[] = [];

  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

  const fetchImpl = (async (raw: string, init: RequestInit = {}) => {
    const url = new URL(raw);
    const headers = new Headers(init.headers);
    // OAuth: protected resource metadata, authorization server metadata, registration, token.
    for (const server of servers.filter((entry) => entry.oauth)) {
      const origin = new URL(server.url).origin;
      const issuer = server.oauth!.issuer;
      if (raw === `${origin}/.well-known/oauth-protected-resource${new URL(server.url).pathname.replace(/\/$/, '')}` || raw === `${origin}/.well-known/oauth-protected-resource`) {
        return json({ resource: server.url, authorization_servers: [issuer], scopes_supported: ['read', 'write'] });
      }
      if (raw === `${issuer}/.well-known/oauth-authorization-server`) {
        return json({ issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register` });
      }
      if (raw === `${issuer}/oauth/register`) {
        registrations.push(JSON.parse(String(init.body)).redirect_uris[0]);
        return json({ client_id: `client-${new URL(issuer).host}` }, { status: 201 });
      }
      if (raw === `${issuer}/oauth/token`) {
        const form = new URLSearchParams(String(init.body));
        tokenRequests.push(form);
        if (form.get('code') !== server.oauth!.code || !form.get('code_verifier')) return json({ error: 'invalid_grant' }, { status: 400 });
        return json({ access_token: server.token, refresh_token: `refresh-${server.token}`, expires_in: 3600, token_type: 'Bearer' });
      }
    }
    const server = servers.find((entry) => url.toString().replace(/\/$/, '') === entry.url.replace(/\/$/, ''));
    if (!server) return new Response('not found', { status: 404 });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (headers.get('authorization') !== `Bearer ${server.token}`) {
      return new Response('{}', { status: 401, headers: server.oauth
        ? { 'www-authenticate': `Bearer resource_metadata="${new URL(server.url).origin}/.well-known/oauth-protected-resource${new URL(server.url).pathname.replace(/\/$/, '')}"` } : {} });
    }
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: Record<string, unknown> };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const answer = (result: unknown) => json({ jsonrpc: '2.0', id: body.id, result }, { headers: { 'mcp-session-id': 's-1' } });
    switch (body.method) {
      case 'initialize': return answer({ protocolVersion: '2025-06-18', serverInfo: { name: new URL(server.url).host, version: '1.0.0' },
        capabilities: { tools: {}, ...(server.resources ? { resources: {} } : {}) } });
      case 'tools/list': return answer({ tools: server.tools });
      case 'resources/list': return answer({ resources: server.resources ?? [] });
      case 'tools/call': {
        const name = String(body.params!.name);
        server.calls.push({ name, args: body.params!.arguments as Record<string, unknown> });
        const output: Record<string, string> = {
          get_issue_details: 'TypeError: cannot read properties of undefined (reading "id") at src/checkout.ts:42',
          get_file_contents: 'export function total(cart) { return cart.items.reduce(...) }',
          create_pull_request: '{"number": 42, "url": "https://github.com/acme/shop/pull/42"}',
          deploy_to_vercel: '{"url": "https://shop-git-fix-checkout.vercel.app"}',
          merge_pull_request: '{"merged": true, "sha": "a18cd21"}',
        };
        return answer({ content: [{ type: 'text', text: output[name] ?? 'ok' }] });
      }
      default: return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown method' } });
    }
  }) as unknown as typeof fetch;

  return { github, sentry, vercel, fetchImpl, registrations, tokenRequests };
}

describe('tool platform: the definition of done', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fake: ReturnType<typeof world>;
  let token: string;
  let userId: string;
  let agentId: string;
  let replies: Response[];
  let sent: string[];

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    fake = world();
    replies = [];
    sent = [];
    const owner = createUser(db, { email: 'kijmoshi@example.com', displayName: 'Kij', passwordHash: 'x', role: 'owner' });
    userId = owner.id;
    token = createSession(db, owner.id);
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'sk-ant-model-provider-key' });
    agentId = createAgent(db, {
      ownerUserId: owner.id, name: 'backend-engineer', personality: '',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-haiku-4-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    }).id;
    const gateway = new AiGateway({
      db, sleep: async () => {},
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent.push(String(init.body));
        return replies.shift() ?? new Response(JSON.stringify({ content: [{ type: 'text', text: '(no more scripted replies)' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      }) as unknown as typeof fetch,
    });
    app = await buildApp({ db, gateway, fetchImpl: fake.fetchImpl });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const headers = () => ({ authorization: `Bearer ${token}`, origin: 'http://localhost:5173' });
  const api = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers: headers(), ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.body ? response.json() : undefined };
  };
  const toolUse = (...calls: Array<[string, Record<string, unknown>]>) => new Response(JSON.stringify({
    content: calls.map(([name, input], index) => ({ type: 'tool_use', id: `call-${name}-${index}-${Math.random().toString(36).slice(2, 6)}`, name, input })),
    stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 10 },
  }));
  const say = (text: string) => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }));
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 400 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(condition()).toBe(true);
  };

  async function signIn(serverId: string, code: string) {
    const start = await api('POST', `/api/v1/mcp-servers/${serverId}/oauth/start`, { callbackUrl: 'http://localhost:5173/oauth/mcp' });
    expect(start.status).toBe(200);
    const authorization = new URL(start.body.authorizationUrl);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('resource')).toBeTruthy();
    const complete = await api('POST', '/api/v1/mcp-servers/oauth/complete', { state: authorization.searchParams.get('state'), code });
    expect(complete.status).toBe(200);
    return complete.body;
  }

  it('connects, installs a skill, fixes a bug, asks before merging, and audits everything without leaking a secret', async () => {
    // 2-4. Connect GitHub, Sentry and Vercel through their official MCP servers.
    const installed: Record<string, string> = {};
    for (const id of ['github', 'sentry', 'vercel']) {
      const result = await api('POST', '/api/v1/registry/install', { itemId: `crewly/${id}`, type: 'mcp_preset' });
      expect(result.status).toBe(201);
      installed[id] = result.body.installedResourceId;
    }
    const secret = createSecret(db, { name: 'GITHUB_TOKEN', value: GITHUB_TOKEN }, { type: 'user', id: userId });
    setSecretGrants(db, secret.id, [{ type: 'mcp_server', id: installed.github! }], { type: 'user', id: userId });
    const githubTest = await api('POST', `/api/v1/mcp-servers/${installed.github}/test`);
    expect(githubTest.body).toMatchObject({ ok: true });

    const sentry = await signIn(installed.sentry!, 'sentry-code');
    expect(sentry).toMatchObject({ ok: true, server: { oauth: { signedIn: true }, trust: 'official', provider: 'sentry', status: 'connected' } });
    expect(sentry.server.resources).toEqual([{ uri: 'sentry://docs/query-syntax', name: 'Query syntax' }]);
    await signIn(installed.vercel!, 'vercel-code');
    expect(fake.registrations).toEqual(['http://localhost:5173/oauth/mcp', 'http://localhost:5173/oauth/mcp']);
    expect(fake.tokenRequests.every((form) => form.get('code_verifier') && form.get('resource'))).toBe(true);

    // 5. Discovered and normalized into one vocabulary, whatever the source.
    const catalog = (await api('GET', '/api/v1/tools')).body.tools as Array<{ ref: string; risk: string; permission: string; source: { trust: string } }>;
    const byRef = new Map(catalog.map((tool) => [tool.ref, tool]));
    expect(byRef.get('github.create_pull_request')).toMatchObject({ risk: 'write', permission: 'pull_request:create', source: { trust: 'official' } });
    expect(byRef.get('github.merge_pull_request')).toMatchObject({ risk: 'deploy', permission: 'pull_request:merge' });
    expect(byRef.get('github.delete_repository')).toMatchObject({ risk: 'dangerous' });
    expect(byRef.get('sentry.get_issue_details')).toMatchObject({ risk: 'read', permission: 'errors:read' });
    expect(byRef.get('vercel.deploy_to_vercel')).toMatchObject({ permission: 'deployment:preview' });
    expect(byRef.get('vercel.promote_deployment')).toMatchObject({ risk: 'deploy', permission: 'deployment:production' });

    const connections = (await api('GET', '/api/v1/connections')).body.connections as Array<{ provider: string; status: string; toolsAvailable: number }>;
    expect(connections.filter((connection) => connection.status === 'connected').map((connection) => connection.provider).sort()).toEqual(['github', 'sentry', 'vercel']);

    // 6-7. Install Production Bug Fixer and see what it needs.
    const skill = await api('POST', '/api/v1/registry/install', { itemId: 'crewly/production-bug-fixer', type: 'skill' });
    expect(skill.status).toBe(201);
    const skillId = skill.body.installedResourceId as string;
    const plan = (await api('GET', `/api/v1/skills/${skillId}/plan`)).body;
    expect(plan.ready).toBe(true);
    expect(plan.requirements.find((entry: { capability: string }) => entry.capability === 'error_tracking').satisfiedBy[0].provider).toBe('sentry');
    const planned = (permission: string) => plan.permissions.find((entry: { permission: string }) => entry.permission === permission);
    expect(planned('pull_request:create').tools.map((tool: { ref: string }) => tool.ref)).toEqual(['github.create_pull_request']);
    expect(planned('pull_request:merge')).toMatchObject({ approval: true, tools: [{ ref: 'github.merge_pull_request' }] });
    expect(planned('deployment:production')).toMatchObject({ approval: true, tools: [{ ref: 'vercel.promote_deployment' }] });

    // 8. Authorize those permissions for the engineering agent.
    // Unacknowledged, it says exactly what it would be accepting.
    const unacknowledged = await api('POST', `/api/v1/agents/${agentId}/skills/${skillId}/authorize`, {});
    expect(unacknowledged.body).toMatchObject({ error: 'capabilities_not_acknowledged', capabilities: ['network'] });
    const authorized = await api('POST', `/api/v1/agents/${agentId}/skills/${skillId}/authorize`, { acknowledgeCapabilities: ['network'] });
    expect(authorized.status).toBe(200);
    expect(authorized.body.skills[0]).toMatchObject({ slug: 'production-bug-fixer', enabled: true });
    const access = (await api('GET', `/api/v1/agents/${agentId}/tool-access`)).body.tools as Array<{ tool: { ref: string }; mode: string; skillId: string }>;
    const mode = (ref: string) => access.find((entry) => entry.tool.ref === ref)?.mode;
    expect(mode('sentry.get_issue_details')).toBe('always');
    expect(mode('github.create_pull_request')).toBe('always');
    expect(mode('github.merge_pull_request')).toBe('ask_every_time');
    expect(mode('vercel.promote_deployment')).toBe('ask_every_time');
    // Least privilege: nothing the skill does not declare, so no delete_repository.
    expect(mode('github.delete_repository')).toBeUndefined();
    expect(access.every((entry) => entry.skillId === skillId)).toBe(true);

    // 9-11. The agent receives a Sentry issue and works it.
    replies.push(
      toolUse(['sentry__get_issue_details', { issueId: 'SHOP-1' }]),
      toolUse(['github__get_file_contents', { repo: 'acme/shop', path: 'src/checkout.ts' }]),
      toolUse(
        ['github__create_branch', { repo: 'acme/shop', branch: 'fix/checkout-empty-cart' }],
        ['github__push_files', { repo: 'acme/shop', branch: 'fix/checkout-empty-cart', files: [{ path: 'src/checkout.ts', content: '…' }], message: 'Handle empty carts' }],
        ['github__create_pull_request', { repo: 'acme/shop', head: 'fix/checkout-empty-cart', base: 'main', title: 'Fix checkout crash on empty cart', body: 'Fixes SHOP-1' }],
        ['vercel__deploy_to_vercel', { project: 'shop', branch: 'fix/checkout-empty-cart' }],
      ),
      toolUse(['github__merge_pull_request', { repo: 'acme/shop', pullNumber: 42 }]),
      say('PR #42 is open with a preview. Merging needs your approval.'),
    );
    const conversation = createConversation(db, { kind: 'dm', name: null, participants: [
      { participantId: userId, participantType: 'user' }, { participantId: agentId, participantType: 'agent' },
    ] });
    await api('POST', `/api/v1/conversations/${conversation.id}/messages`, { body: 'Sentry issue SHOP-1 is failing checkout. Please fix it.' });
    await waitFor(() => sent.length >= 5);

    const offered = (JSON.parse(sent[0]!).tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(offered).toEqual(expect.arrayContaining(['sentry__get_issue_details', 'github__create_pull_request', 'github__merge_pull_request', 'vercel__deploy_to_vercel']));
    expect(offered).not.toContain('github__delete_repository');
    expect(fake.sentry.calls.map((call) => call.name)).toEqual(['get_issue_details']);
    expect(fake.github.calls.map((call) => call.name)).toEqual(['get_file_contents', 'create_branch', 'push_files', 'create_pull_request']);
    expect(fake.vercel.calls.map((call) => call.name)).toEqual(['deploy_to_vercel']);

    // 11. Merging asked first, and did not run.
    const pending = (await api('GET', '/api/v1/approvals')).body as Array<{ id: string; action: string; details: Record<string, unknown> }>;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ action: 'github.merge_pull_request', details: {
      kind: 'tool', risk: 'deploy', permission: 'pull_request:merge', mode: 'ask_every_time',
      connection: { name: 'GitHub', trust: 'official' }, arguments: { repo: 'acme/shop', pullNumber: 42 },
    } });
    expect(JSON.parse(sent[4]!).messages.at(-1).content[0].content).toContain('Approval requested');

    // 12-13. A person approves; Crewly runs exactly that call and tells the conversation.
    replies.push(say('Merged. Watching Sentry for regressions.'));
    const approved = await api('POST', `/api/v1/approvals/${pending[0]!.id}/respond`, { decision: 'approve' });
    expect(approved.body).toMatchObject({ status: 'approved', resolvedBy: userId, execution: { status: 'success', toolRef: 'github.merge_pull_request' } });
    expect(fake.github.calls.at(-1)).toEqual({ name: 'merge_pull_request', args: { repo: 'acme/shop', pullNumber: 42 } });
    const messages = (await api('GET', `/api/v1/conversations/${conversation.id}/messages`)).body;
    const list = (Array.isArray(messages) ? messages : messages.messages) as Array<{ body: string }>;
    expect(list.some((message) => message.body.startsWith('Approved action ran: `github.merge_pull_request`'))).toBe(true);
    // The agent carries on from the result.
    await waitFor(() => sent.length >= 6);
    // Approving twice runs nothing twice.
    expect((await api('POST', `/api/v1/approvals/${pending[0]!.id}/respond`, { decision: 'approve' })).status).toBe(409);
    expect(fake.github.calls.filter((call) => call.name === 'merge_pull_request')).toHaveLength(1);

    // 14. Every tool execution is in the audit log, with who, what and how it went.
    const executions = (await api('GET', '/api/v1/tool-executions')).body.executions as Array<Record<string, unknown>>;
    const summary = executions.map((entry) => `${entry.toolRef} ${entry.status}`).reverse();
    expect(summary).toEqual([
      'sentry.get_issue_details success',
      'github.get_file_contents success',
      'github.create_branch success',
      'github.push_files success',
      'github.create_pull_request success',
      'vercel.deploy_to_vercel success',
      'github.merge_pull_request approval_required',
      'github.merge_pull_request success',
    ]);
    const merge = executions[0]!;
    expect(merge).toMatchObject({ agentId, userId, approvalId: pending[0]!.id, skillId, connectionKind: 'mcp_server', provider: 'github', permission: 'pull_request:merge' });
    expect(typeof merge.durationMs).toBe('number');

    // 15. No GitHub, Sentry or Vercel credential reached the model, the API, the audit log or an approval.
    const everythingTheModelSaw = sent.join('\n');
    const stored = JSON.stringify([
      db.prepare('SELECT * FROM tool_executions').all(),
      db.prepare('SELECT id, action, details, execution FROM approvals').all(),
      db.prepare('SELECT * FROM run_events').all(),
      (await api('GET', '/api/v1/mcp-servers')).body,
      (await api('GET', '/api/v1/connections')).body,
    ]);
    for (const credential of [GITHUB_TOKEN, SENTRY_ACCESS, VERCEL_ACCESS, `refresh-${SENTRY_ACCESS}`]) {
      expect(everythingTheModelSaw).not.toContain(credential);
      expect(stored).not.toContain(credential);
    }
  });

  it('keeps blocked tools away from the model, asks once when told to, and honours workspace blocks', async () => {
    const server = (await api('POST', '/api/v1/registry/install', { itemId: 'crewly/github', type: 'mcp_preset' })).body.installedResourceId as string;
    const secret = createSecret(db, { name: 'GITHUB_TOKEN', value: GITHUB_TOKEN }, { type: 'user', id: userId });
    setSecretGrants(db, secret.id, [{ type: 'mcp_server', id: server }], { type: 'user', id: userId });
    await api('POST', `/api/v1/mcp-servers/${server}/test`);
    await api('PUT', `/api/v1/agents/${agentId}/tools`, { tools: ['get_file_contents', 'create_branch', 'delete_repository'].map((toolName) => ({ serverId: server, toolName })), acknowledgeCapabilities: ['network'] });

    let access = (await api('GET', `/api/v1/agents/${agentId}/tool-access`)).body.tools as Array<{ tool: { ref: string }; mode: string; exposed: boolean; reason: string }>;
    const entry = (ref: string) => access.find((item) => item.tool.ref === ref)!;
    expect(entry('github.get_file_contents').mode).toBe('always');
    expect(entry('github.create_branch').mode).toBe('ask_once');
    expect(entry('github.delete_repository')).toMatchObject({ mode: 'blocked', exposed: false });

    // Even an admin's "always" cannot take a dangerous tool below "ask every time".
    await api('PUT', '/api/v1/tool-policies', { agentId, policies: [{ selectorType: 'tool', selector: 'github.delete_repository', mode: 'always' }] });
    access = (await api('GET', `/api/v1/agents/${agentId}/tool-access`)).body.tools;
    expect(entry('github.delete_repository').mode).toBe('ask_every_time');

    // A workspace block beats any agent rule.
    await api('PUT', '/api/v1/tool-policies', { agentId: null, policies: [{ selectorType: 'risk', selector: 'dangerous', mode: 'blocked' }] });
    access = (await api('GET', `/api/v1/agents/${agentId}/tool-access`)).body.tools;
    expect(entry('github.delete_repository')).toMatchObject({ mode: 'blocked', exposed: false });
    expect(entry('github.delete_repository').reason).toContain('whole workspace');

    // Ask once: the first branch asks; approving it runs it and lets later ones through.
    replies.push(toolUse(['github__create_branch', { branch: 'a' }]), say('asked'));
    const conversation = createConversation(db, { kind: 'dm', name: null, participants: [
      { participantId: userId, participantType: 'user' }, { participantId: agentId, participantType: 'agent' },
    ] });
    await api('POST', `/api/v1/conversations/${conversation.id}/messages`, { body: 'make branch a' });
    await waitFor(() => sent.length >= 2);
    const [approval] = (await api('GET', '/api/v1/approvals')).body as Array<{ id: string }>;
    replies.push(say('branch a made'));
    await api('POST', `/api/v1/approvals/${approval!.id}/respond`, { decision: 'approve' });
    await waitFor(() => sent.length >= 3);
    replies.push(toolUse(['github__create_branch', { branch: 'b' }]), say('done'));
    await api('POST', `/api/v1/conversations/${conversation.id}/messages`, { body: 'make branch b' });
    await waitFor(() => sent.length >= 5);
    expect(fake.github.calls.map((call) => `${call.name}:${call.args.branch}`)).toEqual(['create_branch:a', 'create_branch:b']);
    expect((await api('GET', '/api/v1/approvals')).body).toEqual([]);
  });

  it('offers tool search instead of every schema when an agent has many tools', async () => {
    const many = Array.from({ length: 40 }, (_, i): Tool => ({ name: `describe_resource_${i}`, description: `Describe cloud resource ${i}`, inputSchema: obj({}) }));
    fake.github.tools.push(...many, { name: 'update_dns_record', description: 'Update a DNS record in a Cloudflare zone', inputSchema: obj({ zone: str, name: str, content: str }) });
    const server = (await api('POST', '/api/v1/registry/install', { itemId: 'crewly/github', type: 'mcp_preset' })).body.installedResourceId as string;
    const secret = createSecret(db, { name: 'GITHUB_TOKEN', value: GITHUB_TOKEN }, { type: 'user', id: userId });
    setSecretGrants(db, secret.id, [{ type: 'mcp_server', id: server }], { type: 'user', id: userId });
    await api('POST', `/api/v1/mcp-servers/${server}/test`);
    await api('PUT', `/api/v1/agents/${agentId}/tools`, { tools: fake.github.tools.map((tool) => ({ serverId: server, toolName: tool.name })), acknowledgeCapabilities: ['network'] });

    replies.push(toolUse(['search_tools', { query: 'update DNS record' }]), say('found it'));
    const conversation = createConversation(db, { kind: 'dm', name: null, participants: [
      { participantId: userId, participantType: 'user' }, { participantId: agentId, participantType: 'agent' },
    ] });
    await api('POST', `/api/v1/conversations/${conversation.id}/messages`, { body: 'point www at the new server' });
    await waitFor(() => sent.length >= 2);
    const first = (JSON.parse(sent[0]!).tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(first).toContain('search_tools');
    expect(first.filter((name) => name.startsWith('github__'))).toEqual([]);
    const second = (JSON.parse(sent[1]!).tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(second).toContain('github__update_dns_record');
    expect(second.filter((name) => name.startsWith('github__')).length).toBeLessThanOrEqual(8);
  });
});
