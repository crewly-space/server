import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { openSqlite, type Database } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { CrewlyClient } from '../../src/sdk/client.js';

describe('SDK: the tool platform against a real running server', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let client: CrewlyClient;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db, respond: async () => ({ body: 'ok' }) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || address === null) throw new Error('expected AddressInfo');
    client = new CrewlyClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const setup = await client.auth.setup({ email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' });
    client.setToken(setup.token);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('lists providers, connections, the catalog, policies and the audit log', async () => {
    const { providers } = await client.tools.providers();
    expect(providers.find((provider) => provider.id === 'sentry')).toMatchObject({ category: 'monitoring', areas: expect.arrayContaining(['error_tracking']), connections: 0 });
    expect(providers.find((provider) => provider.id === 'stripe')!.defaultModes).toMatchObject({ 'payout:create': 'blocked' });

    await expect(client.tools.connections()).resolves.toEqual({ connections: [] });
    await expect(client.tools.catalog()).resolves.toEqual({ tools: [] });

    const workspace = await client.tools.setPolicies(null, [{ selectorType: 'risk', selector: 'financial', mode: 'blocked' }]);
    expect(workspace.policies).toMatchObject([{ agentId: null, selectorType: 'risk', selector: 'financial', mode: 'blocked' }]);
    expect((await client.tools.policies()).workspace).toHaveLength(1);

    await expect(client.tools.executions({ limit: 5 })).resolves.toEqual({ executions: [] });
    await expect(client.approvals.history()).resolves.toEqual([]);
  });

  it('shows a skill\'s plan before it is authorized', async () => {
    const { items } = await client.platform.registryItems({ type: 'skill' });
    const bugFixer = items.find((item) => item.id === 'crewly/production-bug-fixer')!;
    expect(bugFixer.listing).toMatchObject({ trust: 'verified', featured: true, writePermissions: expect.arrayContaining(['pull_request:merge']) });
    expect(bugFixer.requiredCapabilities).toEqual(['error_tracking', 'code_host']);

    const installed = await client.platform.installRegistryItem({ itemId: bugFixer.id, type: 'skill' });
    const plan = await client.skills.plan(String(installed.installedResourceId));
    expect(plan).toMatchObject({ ready: false, missing: ['error_tracking', 'code_host'] });
    expect(plan.requirements[0]!.candidates.map((candidate) => candidate.id)).toEqual(['sentry', 'datadog', 'new-relic']);

    await client.providers.create({ id: 'anthropic', kind: 'anthropic', apiKey: 'test-key' });
    const agent = await client.agents.create({ name: 'Engineer', modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' } });
    await expect(client.skills.authorize(agent.id, String(installed.installedResourceId))).rejects.toMatchObject({ status: 409 });
  });
});
