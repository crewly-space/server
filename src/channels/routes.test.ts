import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { createSession } from '../auth/session.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';

type App = Awaited<ReturnType<typeof buildApp>>;

describe('channel routes', () => {
  let db: Database;
  let app: App;
  let owner: string;
  let ownerId: string;
  let member: string;
  let memberId: string;
  let outsider: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    app = await buildApp({ db });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    owner = setup.json().token;
    ownerId = setup.json().user.id;
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    memberId = bob.id;
    member = createSession(db, bob.id);
    const carol = createUser(db, { email: 'carol@example.com', displayName: 'Carol', passwordHash: 'x', role: 'member' });
    outsider = createSession(db, carol.id);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const call = (token: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });

  const create = async (payload: Record<string, unknown>) => {
    const res = await call(owner, 'POST', '/api/v1/channels', payload);
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  it('lets an admin create a channel and normalises its name', async () => {
    const channel = await create({ name: '  #Product Launch ', topic: 'Shipping v2' });
    expect(channel).toMatchObject({
      name: 'product-launch', topic: 'Shipping v2', visibility: 'public', postRole: 'member', joined: true, canPost: true,
    });
    expect(channel.members).toHaveLength(1);
  });

  it('refuses channel management to members', async () => {
    expect((await call(member, 'POST', '/api/v1/channels', { name: 'general' })).statusCode).toBe(403);
    const channel = await create({ name: 'general' });
    expect((await call(member, 'PATCH', `/api/v1/channels/${channel.id}`, { name: 'x' })).statusCode).toBe(403);
    expect((await call(member, 'POST', '/api/v1/channel-categories', { name: 'Team' })).statusCode).toBe(403);
  });

  it('refuses a second live channel with the same name', async () => {
    await create({ name: 'general' });
    expect((await call(owner, 'POST', '/api/v1/channels', { name: 'General' })).statusCode).toBe(409);
  });

  it('keeps DMs and groups separate from channels', async () => {
    await create({ name: 'general' });
    const conversations = await call(owner, 'GET', '/api/v1/conversations');
    expect(conversations.json()).toEqual([]);
  });

  it('lets anyone read and join a public channel, and only members post', async () => {
    const channel = await create({ name: 'general' });
    const listed = (await call(member, 'GET', '/api/v1/channels')).json();
    expect(listed.channels).toHaveLength(1);
    expect(listed.channels[0]).toMatchObject({ joined: false, canPost: false });

    await call(owner, 'POST', `/api/v1/conversations/${channel.id}/messages`, { body: 'hello' });
    const history = await call(member, 'GET', `/api/v1/conversations/${channel.id}/messages`);
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(1);

    expect((await call(member, 'POST', `/api/v1/conversations/${channel.id}/messages`, { body: 'hi' })).statusCode).toBe(403);
    const joined = await call(member, 'POST', `/api/v1/channels/${channel.id}/join`);
    expect(joined.json()).toMatchObject({ joined: true, canPost: true });
    expect((await call(member, 'POST', `/api/v1/conversations/${channel.id}/messages`, { body: 'hi' })).statusCode).toBe(201);

    expect((await call(member, 'POST', `/api/v1/channels/${channel.id}/leave`)).statusCode).toBe(204);
    expect((await call(member, 'POST', `/api/v1/conversations/${channel.id}/messages`, { body: 'again' })).statusCode).toBe(403);
  });

  it('hides a private channel from everyone but its members', async () => {
    const channel = await create({ name: 'leadership', visibility: 'private' });
    expect((await call(member, 'GET', '/api/v1/channels')).json().channels).toEqual([]);
    expect((await call(member, 'GET', `/api/v1/channels/${channel.id}`)).statusCode).toBe(404);
    expect((await call(member, 'POST', `/api/v1/channels/${channel.id}/join`)).statusCode).toBe(404);
    expect((await call(member, 'GET', `/api/v1/conversations/${channel.id}/messages`)).statusCode).toBe(403);

    await call(owner, 'POST', `/api/v1/channels/${channel.id}/members`, { participantId: memberId, participantType: 'user' });
    expect((await call(member, 'GET', '/api/v1/channels')).json().channels).toHaveLength(1);
    expect((await call(member, 'GET', `/api/v1/conversations/${channel.id}/messages`)).statusCode).toBe(200);
    expect((await call(outsider, 'GET', '/api/v1/channels')).json().channels).toEqual([]);

    await call(owner, 'DELETE', `/api/v1/channels/${channel.id}/members/user/${memberId}`);
    expect((await call(member, 'GET', `/api/v1/conversations/${channel.id}/messages`)).statusCode).toBe(403);
  });

  it('lets a channel be read by all and posted to only by admins', async () => {
    const channel = await create({ name: 'announcements', postRole: 'admin' });
    await call(member, 'POST', `/api/v1/channels/${channel.id}/join`);
    const res = await call(member, 'POST', `/api/v1/conversations/${channel.id}/messages`, { body: 'hi' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('channel_post_restricted');
    expect((await call(owner, 'POST', `/api/v1/conversations/${channel.id}/messages`, { body: 'news' })).statusCode).toBe(201);
  });

  it('archives a channel: hidden, readable, not postable, and restorable', async () => {
    const channel = await create({ name: 'old' });
    const archived = await call(owner, 'PATCH', `/api/v1/channels/${channel.id}`, { archived: true });
    expect(archived.json().archivedAt).not.toBeNull();
    expect((await call(owner, 'GET', '/api/v1/channels')).json().channels).toEqual([]);
    expect((await call(owner, 'GET', '/api/v1/channels?includeArchived=true')).json().channels).toHaveLength(1);
    expect((await call(owner, 'POST', `/api/v1/conversations/${channel.id}/messages`, { body: 'x' })).statusCode).toBe(409);
    expect((await call(owner, 'GET', `/api/v1/conversations/${channel.id}/messages`)).statusCode).toBe(200);

    // Its name is free while it is archived, so restoring it must not clash.
    await create({ name: 'old' });
    expect((await call(owner, 'PATCH', `/api/v1/channels/${channel.id}`, { archived: false })).statusCode).toBe(409);
    expect((await call(owner, 'PATCH', `/api/v1/channels/${channel.id}`, { archived: false, name: 'old-2' })).statusCode).toBe(200);
  });

  it('renames a channel and changes its topic', async () => {
    const channel = await create({ name: 'general' });
    const res = await call(owner, 'PATCH', `/api/v1/channels/${channel.id}`, { name: 'Town Hall', topic: '' });
    expect(res.json()).toMatchObject({ name: 'town-hall', topic: null });
  });

  it('sorts channels into categories and orders both', async () => {
    const team = (await call(owner, 'POST', '/api/v1/channel-categories', { name: 'Team' })).json();
    const projects = (await call(owner, 'POST', '/api/v1/channel-categories', { name: 'Projects' })).json();
    const a = await create({ name: 'a', categoryId: team.id });
    const b = await create({ name: 'b', categoryId: team.id });
    const c = await create({ name: 'c' });

    expect((await call(owner, 'PUT', '/api/v1/channels/order', { categoryId: team.id, channelIds: [b.id, c.id, a.id] })).statusCode).toBe(204);
    await call(owner, 'PUT', '/api/v1/channel-categories/order', { categoryIds: [projects.id, team.id] });
    const listed = (await call(owner, 'GET', '/api/v1/channels')).json();
    expect(listed.categories.map((x: { name: string }) => x.name)).toEqual(['Projects', 'Team']);
    expect(listed.channels.filter((x: { categoryId: string }) => x.categoryId === team.id).map((x: { name: string }) => x.name))
      .toEqual(['b', 'c', 'a']);

    expect((await call(owner, 'DELETE', `/api/v1/channel-categories/${team.id}`)).statusCode).toBe(204);
    const after = (await call(owner, 'GET', '/api/v1/channels')).json();
    expect(after.channels).toHaveLength(3);
    expect(after.channels.every((x: { categoryId: string | null }) => x.categoryId === null)).toBe(true);
  });

  it('keeps a blocked agent out of a channel and away from its mentions', async () => {
    const agent = createAgent(db, {
      ownerUserId: ownerId, name: 'Scout', personality: 'Researcher', modelPolicy: { defaultProviderId: 'none', defaultModel: 'm' },
      permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false },
    });
    const channel = await create({ name: 'general', members: [{ participantId: agent.id, participantType: 'agent' }] });
    expect(channel.members.some((m: { participantId: string }) => m.participantId === agent.id)).toBe(true);

    const blocked = (await call(owner, 'PUT', `/api/v1/channels/${channel.id}/agents/${agent.id}/block`)).json();
    expect(blocked.blockedAgentIds).toEqual([agent.id]);
    expect(blocked.members.some((m: { participantId: string }) => m.participantId === agent.id)).toBe(false);
    const add = await call(owner, 'POST', `/api/v1/channels/${channel.id}/members`, { participantId: agent.id, participantType: 'agent' });
    expect(add.statusCode).toBe(409);

    const unblocked = (await call(owner, 'DELETE', `/api/v1/channels/${channel.id}/agents/${agent.id}/block`)).json();
    expect(unblocked.blockedAgentIds).toEqual([]);
    expect((await call(owner, 'POST', `/api/v1/channels/${channel.id}/members`, { participantId: agent.id, participantType: 'agent' })).statusCode).toBe(200);
  });
});
