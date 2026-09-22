import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAgent } from '../agents/repository.js';
import { createSession } from '../auth/session.js';
import { createConversation } from '../conversations/repository.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { AiGateway } from '../gateway/gateway.js';
import { createProviderConfig } from '../providers/repository.js';
import { createSecret } from '../secrets/vault.js';
import { createUser } from '../users/repository.js';
import { parseSkillManifest, renderSkill, type Skill } from './skills.js';

const MANIFEST = `---
name: Release notes
description: Writes release notes the team's way
version: 1.2.0
config: [{"key":"repo","label":"Repository","required":true},{"key":"token","label":"GitHub token","secret":true}]
---
Write release notes for {{config.repo}}. Group changes under Features, Fixes and Chores.
Token for the API: {{config.token}}`;

describe('skill manifests and rendering', () => {
  it('reads frontmatter and instructions', () => {
    expect(parseSkillManifest(MANIFEST)).toMatchObject({
      name: 'Release notes',
      description: "Writes release notes the team's way",
      version: '1.2.0',
      source: 'installed',
      configFields: [
        { key: 'repo', label: 'Repository', secret: false, required: true },
        { key: 'token', label: 'GitHub token', secret: true, required: false },
      ],
    });
  });

  it('refuses a manifest without frontmatter or instructions', () => {
    expect(() => parseSkillManifest('just text')).toThrow(/frontmatter/);
    expect(() => parseSkillManifest('---\nname: x\n---\n')).toThrow('The manifest has no instructions');
  });

  it('fills plain settings into the instructions and never a secret', () => {
    const skill = { ...parseSkillManifest(MANIFEST), id: 's', slug: 'release-notes' } as Skill;
    const rendered = renderSkill(skill, { repo: 'crewly-space/server', token: '{{secret:GH_TOKEN}}' });
    expect(rendered).toContain('Write release notes for crewly-space/server.');
    expect(rendered).toContain('Token for the API: [GitHub token: configured]');
    expect(rendered).toContain('- GitHub token: configured (secret)');
    expect(rendered).not.toContain('GH_TOKEN');
  });
});

describe('skill routes and agent turns', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken: string;
  let memberToken: string;
  let memberId: string;
  let agentId: string;
  let sent: Array<{ system?: string }>;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    sent = [];
    ownerToken = createSession(db, createUser(db, { email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'owner' }).id);
    memberId = createUser(db, { email: 'm@example.com', displayName: 'M', passwordHash: 'x', role: 'member' }).id;
    memberToken = createSession(db, memberId);
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'sk' });
    agentId = createAgent(db, {
      ownerUserId: memberId,
      name: 'Writer',
      personality: 'Be brief.',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-haiku-4-5' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    }).id;
    const gateway = new AiGateway({
      db,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      }) as unknown as typeof fetch,
    });
    app = await buildApp({ db, gateway });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const install = () =>
    app.inject({ method: 'POST', url: '/api/v1/skills/install', headers: as(ownerToken), payload: { manifest: MANIFEST, sourceRef: 'https://skills.example.com/release-notes' } });

  it('lets admins add skills and everyone read them', async () => {
    const denied = await app.inject({
      method: 'POST', url: '/api/v1/skills', headers: as(memberToken), payload: { name: 'x', instructions: 'y' },
    });
    expect(denied.statusCode).toBe(403);

    const installed = await install();
    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({ slug: 'release-notes', source: 'installed', sourceRef: 'https://skills.example.com/release-notes', version: '1.2.0' });
    expect((await install()).statusCode).toBe(409);

    const custom = await app.inject({
      method: 'POST', url: '/api/v1/skills', headers: as(ownerToken),
      payload: { name: 'Code review', instructions: 'Review for correctness first, style last.' },
    });
    expect(custom.json()).toMatchObject({ slug: 'code-review', source: 'custom' });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/skills', headers: as(memberToken) });
    expect(listed.json().skills.map((s: { name: string }) => s.name)).toEqual(['Code review', 'Release notes']);
  });

  it('will not take a pasted value for a secret setting', async () => {
    const skillId = (await install()).json().id;
    const pasted = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${agentId}/skills`, headers: as(memberToken),
      payload: { skills: [{ skillId, config: { repo: 'a/b', token: 'ghp_pasted' } }] },
    });
    expect(pasted.json()).toMatchObject({
      error: 'invalid_skill_config',
      message: 'GitHub token is a secret: choose one from the vault ({{secret:NAME}}) instead of pasting it',
    });
    const missing = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${agentId}/skills`, headers: as(memberToken), payload: { skills: [{ skillId, config: {} }] },
    });
    expect(missing.json().message).toBe('Repository is required');
  });

  it('gives an agent its skills in the system prompt, without the secret', async () => {
    const skillId = (await install()).json().id;
    const assigned = await app.inject({
      method: 'PUT', url: `/api/v1/agents/${agentId}/skills`, headers: as(memberToken),
      payload: { skills: [{ skillId, config: { repo: 'crewly-space/server', token: '{{secret:GH_TOKEN}}' } }] },
    });
    expect(assigned.statusCode).toBe(200);

    const conversation = createConversation(db, {
      kind: 'dm', name: null,
      participants: [{ participantId: memberId, participantType: 'user' }, { participantId: agentId, participantType: 'agent' }],
    });
    await app.inject({ method: 'POST', url: `/api/v1/conversations/${conversation.id}/messages`, headers: as(memberToken), payload: { body: 'notes please' } });
    for (let i = 0; i < 200 && sent.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent[0]!.system).toContain('Agent instructions: Be brief.');
    expect(sent[0]!.system).toContain('## Skill: Release notes');
    expect(sent[0]!.system).toContain('Write release notes for crewly-space/server.');
    expect(sent[0]!.system).not.toContain('GH_TOKEN');
  });

  it('shows up as a dependent of the secret it refers to', async () => {
    const secret = createSecret(db, { name: 'GH_TOKEN', value: 'v' }, { type: 'system', id: null });
    const skillId = (await install()).json().id;
    await app.inject({
      method: 'PUT', url: `/api/v1/agents/${agentId}/skills`, headers: as(memberToken),
      payload: { skills: [{ skillId, config: { repo: 'a/b', token: '{{secret:GH_TOKEN}}' } }] },
    });
    const dependents = await app.inject({ method: 'GET', url: `/api/v1/secrets/${secret.id}/dependents`, headers: as(ownerToken) });
    expect(dependents.json().dependents).toEqual([{ type: 'skill', id: skillId, name: 'Release notes on Writer', via: 'reference' }]);
  });

  it('stops using a skill that was switched off for the agent', async () => {
    const skillId = (await install()).json().id;
    await app.inject({
      method: 'PUT', url: `/api/v1/agents/${agentId}/skills`, headers: as(memberToken),
      payload: { skills: [{ skillId, enabled: false, config: { repo: 'a/b' } }] },
    });
    const listed = await app.inject({ method: 'GET', url: `/api/v1/agents/${agentId}/skills`, headers: as(memberToken) });
    expect(listed.json().skills).toMatchObject([{ name: 'Release notes', enabled: false }]);
  });
});
