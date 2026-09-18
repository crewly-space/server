import { openSqlite, type Database } from '../db/driver.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { createSession } from '../auth/session.js';
import { createUser } from '../users/repository.js';

describe('conversation routes', () => {
  let db: Database;

  beforeEach(() => {
    db = openSqlite(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  async function setupOwner(app: Awaited<ReturnType<typeof buildApp>>) {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'owner@example.com', displayName: 'Owner', password: 'super-secret-1' },
    });
    return { token: setup.json().token as string, userId: setup.json().user.id as string };
  }

  it('creates a dm with an existing user and lists it back', async () => {
    const app = await buildApp({ db });
    const { token } = await setupOwner(app);
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: bob.id, participantType: 'user' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().kind).toBe('dm');
    expect(create.json().participants).toHaveLength(2);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    await app.close();
  });

  it('rejects a dm with a nonexistent participant', async () => {
    const app = await buildApp({ db });
    const { token } = await setupOwner(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: 'nonexistent', participantType: 'user' },
    });
    expect(create.statusCode).toBe(404);

    await app.close();
  });

  it('creates a named group with multiple participants', async () => {
    const app = await buildApp({ db });
    const { token } = await setupOwner(app);
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const carol = createUser(db, { email: 'carol@example.com', displayName: 'Carol', passwordHash: 'y', role: 'member' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Team',
        participants: [
          { participantId: bob.id, participantType: 'user' },
          { participantId: carol.id, participantType: 'user' },
        ],
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().name).toBe('Team');
    expect(create.json().participants).toHaveLength(3);

    await app.close();
  });

  it('rejects conversation creation without authentication', async () => {
    const app = await buildApp({ db });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { participantId: 'anyone', participantType: 'user' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('allows the owner to add and remove a group member', async () => {
    const app = await buildApp({ db });
    const { token } = await setupOwner(app);
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const carol = createUser(db, { email: 'carol@example.com', displayName: 'Carol', passwordHash: 'y', role: 'member' });

    const group = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Team', participants: [{ participantId: bob.id, participantType: 'user' }] },
    });
    const groupId = group.json().id as string;

    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${groupId}/members`,
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: carol.id, participantType: 'user' },
    });
    expect(add.statusCode).toBe(204);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/conversations/${groupId}/members/${carol.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(remove.statusCode).toBe(204);

    await app.close();
  });

  it('rejects membership changes from a member-role user', async () => {
    const app = await buildApp({ db });
    const { token } = await setupOwner(app);
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const carol = createUser(db, { email: 'carol@example.com', displayName: 'Carol', passwordHash: 'y', role: 'member' });
    const bobToken = createSession(db, bob.id);

    const group = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Team', participants: [{ participantId: bob.id, participantType: 'user' }] },
    });
    const groupId = group.json().id as string;

    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${groupId}/members`,
      headers: { authorization: `Bearer ${bobToken}` },
      payload: { participantId: carol.id, participantType: 'user' },
    });
    expect(add.statusCode).toBe(403);

    await app.close();
  });

  it('rejects a dm where the participant is the caller (self-dm)', async () => {
    const app = await buildApp({ db });
    const { token, userId } = await setupOwner(app);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: userId, participantType: 'user' },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json().error).toBe('cannot_dm_self');

    await app.close();
  });

  it('dedupes the caller out of a group participants list without a 500', async () => {
    const app = await buildApp({ db });
    const { token, userId } = await setupOwner(app);
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Team',
        participants: [
          { participantId: bob.id, participantType: 'user' },
          { participantId: userId, participantType: 'user' },
        ],
      },
    });
    expect(create.statusCode).toBe(201);
    const participants = create.json().participants as Array<{ participantId: string }>;
    expect(participants).toHaveLength(2);
    expect(participants.filter((p) => p.participantId === userId)).toHaveLength(1);

    await app.close();
  });

  it('rejects re-adding an existing group member with 409, not a 500', async () => {
    const app = await buildApp({ db });
    const { token } = await setupOwner(app);
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });

    const group = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/group',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Team', participants: [{ participantId: bob.id, participantType: 'user' }] },
    });
    const groupId = group.json().id as string;

    const readd = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${groupId}/members`,
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: bob.id, participantType: 'user' },
    });
    expect(readd.statusCode).toBe(409);
    expect(readd.json().error).toBe('already_a_participant');

    await app.close();
  });

  it('returns the existing dm conversation on a second create for the same pair', async () => {
    const app = await buildApp({ db });
    const { token } = await setupOwner(app);
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: bob.id, participantType: 'user' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: bob.id, participantType: 'user' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json()).toHaveLength(1);

    await app.close();
  });

  it('rejects adding a member to a dm conversation', async () => {
    const app = await buildApp({ db });
    const { token } = await setupOwner(app);
    const bob = createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: 'x', role: 'member' });
    const carol = createUser(db, { email: 'carol@example.com', displayName: 'Carol', passwordHash: 'y', role: 'member' });

    const dm = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: bob.id, participantType: 'user' },
    });

    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${dm.json().id}/members`,
      headers: { authorization: `Bearer ${token}` },
      payload: { participantId: carol.id, participantType: 'user' },
    });
    expect(add.statusCode).toBe(400);

    await app.close();
  });
});
