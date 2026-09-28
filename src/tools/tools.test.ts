import { describe, expect, it } from 'vitest';
import { callRisk, classifySql, classifyTool } from './classify.js';
import { defineConnector, ConnectorDefinitionError } from './connector-sdk.js';
import { modelToolName } from './catalog.js';
import { NATIVE_CONNECTORS } from './native.js';
import { detectProvider } from './providers.js';
import { checkArguments, checkInputSchema, redactArguments, REDACTED } from './schema.js';
import { searchTools } from './search.js';

describe('tool classification', () => {
  it('classifies the official GitHub, Sentry and Vercel MCP tools into the shared vocabulary', () => {
    const check = (provider: string, name: string) => {
      const { risk, permission } = classifyTool({ name, provider });
      return `${risk} ${permission}`;
    };
    expect(check('github', 'get_file_contents')).toBe('read repo:read');
    expect(check('github', 'list_commits')).toBe('read repo:read');
    expect(check('github', 'create_branch')).toBe('write branch:create');
    expect(check('github', 'push_files')).toBe('write commit:create');
    expect(check('github', 'create_pull_request')).toBe('write pull_request:create');
    expect(check('github', 'merge_pull_request')).toBe('deploy pull_request:merge');
    expect(check('github', 'pull_request_read')).toBe('read pull_request:read');
    expect(check('github', 'delete_repository')).toBe('dangerous repo:delete');
    expect(check('sentry', 'search_issues')).toBe('read errors:read');
    expect(check('sentry', 'get_issue_details')).toBe('read errors:read');
    expect(check('vercel', 'get_deployment_build_logs')).toBe('read logs:read');
    expect(check('vercel', 'deploy_to_vercel')).toBe('write deployment:preview');
    expect(check('vercel', 'promote_deployment')).toBe('deploy deployment:production');
  });

  it('treats money and messages as their own risks', () => {
    expect(classifyTool({ name: 'create_refund', provider: 'stripe' })).toMatchObject({ risk: 'financial', permission: 'refund:create' });
    expect(classifyTool({ name: 'create_payout', provider: 'stripe' })).toMatchObject({ risk: 'financial', permission: 'payout:create' });
    expect(classifyTool({ name: 'list_customers', provider: 'stripe' })).toMatchObject({ risk: 'read', permission: 'customer:read' });
    expect(classifyTool({ name: 'send_email', provider: 'gmail' })).toMatchObject({ risk: 'external_message', permission: 'email:send' });
    expect(classifyTool({ name: 'create_draft', provider: 'gmail' })).toMatchObject({ risk: 'write', permission: 'email:draft' });
    expect(classifyTool({ name: 'send_message' })).toMatchObject({ risk: 'external_message' });
  });

  it('never assumes an unknown tool is harmless, and only believes read-only hints from trusted servers', () => {
    expect(classifyTool({ name: 'frobnicate' })).toMatchObject({ risk: 'write', basis: 'unknown' });
    expect(classifyTool({ name: 'frobnicate', annotations: { readOnlyHint: true } }).risk).toBe('write');
    expect(classifyTool({ name: 'frobnicate', annotations: { readOnlyHint: true }, trustAnnotations: true }).risk).toBe('read');
    // A destructive hint is believed from anyone: it can only make a tool look riskier.
    expect(classifyTool({ name: 'update_thing', annotations: { destructiveHint: true } }).risk).toBe('delete');
    expect(classifyTool({ name: 'delete_project' }).risk).toBe('dangerous');
    expect(classifyTool({ name: 'update_permissions' }).risk).toBe('admin');
  });

  it('strips a product prefix from tool names', () => {
    expect(classifyTool({ name: 'notion-search', provider: 'notion' }).permission).toBe('docs:read');
    expect(classifyTool({ name: 'notion-create-pages', provider: 'notion' })).toMatchObject({ risk: 'write', permission: 'docs:create' });
  });
});

describe('SQL guard', () => {
  it('lets single reads through and flags destructive statements', () => {
    expect(classifySql('SELECT * FROM users WHERE id = 1')).toBe('read');
    expect(classifySql('with t as (select 1) select * from t;')).toBe('read');
    expect(classifySql('EXPLAIN ANALYZE SELECT 1')).toBe('read');
    expect(classifySql("UPDATE users SET name = 'x' WHERE id = 3")).toBe('write');
    expect(classifySql('INSERT INTO logs VALUES (1)')).toBe('write');
    expect(classifySql('DELETE FROM users')).toBe('destructive');
    expect(classifySql('DELETE FROM users WHERE 1=1')).toBe('destructive');
    expect(classifySql("UPDATE users SET admin = true")).toBe('destructive');
    expect(classifySql('DROP TABLE users')).toBe('destructive');
    expect(classifySql('TRUNCATE orders')).toBe('destructive');
    expect(classifySql('ALTER TABLE users ADD COLUMN x int')).toBe('destructive');
    expect(classifySql('SELECT 1; DROP TABLE users')).toBe('destructive');
    // Keywords inside strings and comments do not count.
    expect(classifySql("SELECT 'DROP TABLE users' AS text -- DELETE FROM x")).toBe('read');
  });

  it('decides the risk of a SQL tool per call', () => {
    const tool = { risk: 'execute' as const, permission: 'query:execute' };
    expect(callRisk(tool, { sql: 'select 1' })).toEqual({ risk: 'read', permission: 'data:read' });
    expect(callRisk(tool, { query: 'drop table x' })).toEqual({ risk: 'dangerous', permission: 'destructive:execute' });
    // A docs search that happens to take a "query" is not SQL.
    expect(callRisk({ risk: 'read', permission: 'docs:read' }, { query: 'how do I drop a table' })).toEqual({ risk: 'read', permission: 'docs:read' });
  });
});

describe('schemas, arguments and redaction', () => {
  it('refuses schemas a model should not be handed', () => {
    expect(checkInputSchema(undefined).issues).toEqual([]);
    expect(checkInputSchema({ type: 'array' }).issues[0]).toContain('not "object"');
    expect(checkInputSchema({ type: 'object', properties: { a: { $ref: 'https://evil.example/schema' } } }).issues).toContain('schema refers to an external $ref');
    expect(checkInputSchema({ type: 'object', description: 'x'.repeat(40_000) }).issues[0]).toContain('bytes');
  });

  it('checks a model\'s arguments before anything is sent', () => {
    const schema = { type: 'object', properties: { repo: { type: 'string' }, n: { type: 'integer' } }, required: ['repo'], additionalProperties: false };
    expect(checkArguments(schema, { repo: 'a/b', n: 2 })).toBeNull();
    expect(checkArguments(schema, {})).toBe('missing required argument: repo');
    expect(checkArguments(schema, { repo: 'a/b', extra: 1 })).toBe('unknown argument: extra');
    expect(checkArguments(schema, { repo: 1 })).toBe('repo should be string, not number');
  });

  it('keeps secrets out of what is stored', () => {
    const redacted = redactArguments({
      repo: 'acme/api', token: 'abc123', headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop' },
      note: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 and sk_live_abcdefghijklmno', dsn: 'postgres://app:hunter2@db.internal/app',
      body: 'the secret value is s3cr3t-value-here',
    }, ['s3cr3t-value-here']);
    const text = JSON.stringify(redacted);
    expect(text).toContain('acme/api');
    for (const leaked of ['abc123', 'eyJhbGci', 'ghp_', 'sk_live_', 'hunter2', 's3cr3t']) expect(text).not.toContain(leaked);
    expect(text).toContain(REDACTED);
  });
});

describe('tool search and names', () => {
  const tool = (ref: string, description: string, extra: Partial<{ provider: string; areas: string[] }> = {}) => {
    const [namespace, name] = ref.split('.') as [string, string];
    return { ref, name, namespace, provider: extra.provider ?? namespace, permission: classifyTool({ name, provider: namespace }).permission,
      description, category: 'other' as const, areas: extra.areas ?? [] };
  };
  const tools = [
    tool('cloudflare.update_dns_record', 'Update a DNS record in a zone', { areas: ['dns'] }),
    tool('cloudflare.list_workers', 'List Workers scripts'),
    tool('github.create_pull_request', 'Open a pull request'),
    tool('sentry.search_issues', 'Search Sentry issues', { areas: ['error_tracking'] }),
    ...Array.from({ length: 200 }, (_, i) => tool(`aws.describe_thing_${i}`, `Describe AWS thing ${i}`)),
  ];

  it('finds the few tools a task needs among hundreds', () => {
    expect(searchTools(tools, 'cloudflare update DNS record', 3)[0]!.tool.ref).toBe('cloudflare.update_dns_record');
    expect(searchTools(tools, 'open a PR')[0]!.tool.ref).toBe('github.create_pull_request');
    expect(searchTools(tools, 'find production errors')[0]!.tool.ref).toBe('sentry.search_issues');
    expect(searchTools(tools, 'zzzz')).toEqual([]);
  });

  it('gives every tool a model-safe, unique name', () => {
    expect(modelToolName('github.create_pull_request')).toBe('github__create_pull_request');
    const long = modelToolName(`cloudflare-some-long-account.${'x'.repeat(80)}`);
    expect(long).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(long).not.toBe(modelToolName(`cloudflare-some-long-account.${'x'.repeat(79)}y`));
  });

  it('knows a provider from its MCP host', () => {
    expect(detectProvider('https://mcp.sentry.dev/mcp')).toBe('sentry');
    expect(detectProvider('https://api.githubcopilot.com/mcp/')).toBe('github');
    expect(detectProvider('https://observability.mcp.cloudflare.com/mcp')).toBe('cloudflare');
    expect(detectProvider('https://example.com/mcp')).toBeNull();
  });
});

describe('connector SDK', () => {
  const tool = { name: 'list_customers', description: 'List customers', inputSchema: { type: 'object' }, permission: 'customers:read', execute: async () => [] };

  it('declares a connector and checks it', () => {
    const stripe = defineConnector({ id: 'stripe', name: 'Stripe', category: 'finance', auth: { type: 'oauth2' }, tools: [tool], permissions: ['customers:read'] });
    expect(stripe.tools.map((entry) => entry.name)).toEqual(['list_customers']);
    expect(() => defineConnector({ id: 'stripe', name: 'Stripe', category: 'finance', auth: { type: 'oauth2' }, tools: [tool], permissions: [] }))
      .toThrow(ConnectorDefinitionError);
    expect(() => defineConnector({ id: 'Stripe!', name: 'Stripe', category: 'finance', auth: { type: 'oauth2' }, tools: [], permissions: [] }))
      .toThrow('lowercase');
  });

  it('describes every native connector through it', () => {
    expect(NATIVE_CONNECTORS.github.tools.find((entry) => entry.name === 'create_issue')).toMatchObject({ risk: 'write', permission: 'issue:create' });
    expect(NATIVE_CONNECTORS.gmail.tools.find((entry) => entry.name === 'send_email')).toMatchObject({ risk: 'external_message', permission: 'email:send' });
    // Slack's post tool takes the channel and text it needs.
    expect(NATIVE_CONNECTORS.slack.tools.find((entry) => entry.name === 'post_messages')!.inputSchema).toMatchObject({ required: ['channel', 'text'] });
  });
});
