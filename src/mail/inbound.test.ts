import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { createConversation } from '../conversations/repository.js';
import { openSqlite, type Database } from '../db/driver.js';
import { encryptDatabaseSecret } from '../db/secrets.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { ConnectionHub } from '../ws/hub.js';
import { pullInboundMail, replyAddress, stripQuotedReply, type InboundMessage } from './inbound.js';

/** Crewly's inbound queue for this server, and what the server acknowledged. */
class FakeInbound {
  queue: InboundMessage[] = [];
  acks: Array<{ id: string; body: unknown }> = [];
  routes: Array<{ address: string; target: string }> = [];
  addressCalls = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
    if (url.pathname === '/api/v1/instance/mail/inbound/address') {
      this.addressCalls += 1;
      return json(200, { domain: 'inbound.crewly.test', key: 'k0k0k0k0k0' });
    }
    if (url.pathname === '/api/v1/instance/mail/inbound') return json(200, { messages: this.queue });
    const ack = url.pathname.match(/^\/api\/v1\/instance\/mail\/inbound\/(.+)\/ack$/);
    if (ack) {
      this.acks.push({ id: decodeURIComponent(ack[1]!), body: JSON.parse(String(init!.body)) });
      return json(204);
    }
    if (url.pathname === '/api/v1/instance/mail/inbound/routes' && method === 'POST') {
      const body = JSON.parse(String(init!.body));
      if (!body.address.endsWith('@acme.com')) return json(403, { error: 'example.com is not a verified sending domain of this server' });
      this.routes.push(body);
      return json(201, { route: body });
    }
    return json(404, { error: 'not found' });
  };
}

describe('inbound mail', () => {
  let db: Database;
  let hub: ConnectionHub;
  let crewly: FakeInbound;
  let ada: { id: string; email: string };
  let grace: { id: string };
  let conversationId: string;

  beforeEach(() => {
    db = openSqlite(':memory:');
    runMigrations(db);
    hub = new ConnectionHub(db);
    crewly = new FakeInbound();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO crewly_connection (id, cloud_url, status, instance_id, credential_ciphertext, credential_version, scopes, connected_at, updated_at)
       VALUES (1, 'https://crewly.test', 'connected', 'inst-1', ?, 1, '["mail:send","mail:receive"]', ?, ?)`,
    ).run(encryptDatabaseSecret(db, 'crewly_inst_x'), now, now);
    ada = createUser(db, { email: 'ada@example.com', displayName: 'Ada', passwordHash: 'x', role: 'owner' });
    grace = createUser(db, { email: 'grace@example.com', displayName: 'Grace', passwordHash: 'x', role: 'member' });
    conversationId = createConversation(db, { kind: 'group', name: 'builds', participants: [{ participantId: ada.id, participantType: 'user' }, { participantId: grace.id, participantType: 'user' }] }).id;
  });
  afterEach(() => db.close());

  const inbound = (overrides: Partial<InboundMessage>): InboundMessage => ({
    id: `in-${crewly.queue.length + 1}`,
    kind: 'reply',
    target: '',
    recipient: '',
    from: { email: 'ada@example.com', name: 'Ada' },
    subject: 'Re: builds',
    text: 'On it.\n\nOn Tue, Crewly wrote:\n> build failed',
    html: null,
    headers: {},
    attachments: [],
    authenticated: true,
    receivedAt: new Date().toISOString(),
    ...overrides,
  });
  const messages = () => db.prepare('SELECT author_id, body FROM messages ORDER BY created_at').all() as Array<{ author_id: string; body: string }>;

  it('gives each person a stable reply address per conversation', async () => {
    const first = await replyAddress(db, crewly.fetch, conversationId, ada.id);
    expect(first).toMatch(/^reply\+k0k0k0k0k0\.[a-z0-9]{16}@inbound\.crewly\.test$/);
    expect(await replyAddress(db, crewly.fetch, conversationId, ada.id)).toBe(first);
    expect(await replyAddress(db, crewly.fetch, conversationId, grace.id)).not.toBe(first);
    expect(crewly.addressCalls).toBe(1);
  });

  it('posts a reply as the person it was addressed to, without the quoted text, and acknowledges it once', async () => {
    const address = (await replyAddress(db, crewly.fetch, conversationId, ada.id))!;
    const token = address.split('.')[1]!.split('@')[0]!;
    crewly.queue = [inbound({ target: token, recipient: address })];
    expect(await pullInboundMail(db, crewly.fetch, hub)).toBe(1);
    expect(messages()).toEqual([{ author_id: ada.id, body: 'On it.' }]);
    expect(crewly.acks).toEqual([{ id: 'in-1', body: { status: 'delivered' } }]);

    // Crewly hands the same message over again: nothing doubles, it is only acknowledged.
    await pullInboundMail(db, crewly.fetch, hub);
    expect(messages()).toHaveLength(1);
    expect(crewly.acks).toHaveLength(2);
  });

  it('refuses a reply from anyone but the addressee, or one whose sender failed SPF/DKIM', async () => {
    const address = (await replyAddress(db, crewly.fetch, conversationId, ada.id))!;
    const token = address.split('.')[1]!.split('@')[0]!;
    crewly.queue = [
      inbound({ id: 'forged', target: token, from: { email: 'mallory@evil.test', name: null } }),
      inbound({ id: 'unverified', target: token, authenticated: false }),
      inbound({ id: 'unknown', target: 'zzzzzzzzzzzzzzzz' }),
    ];
    await pullInboundMail(db, crewly.fetch, hub);
    expect(messages()).toEqual([]);
    expect(crewly.acks.map((ack) => ack.body)).toEqual([
      { status: 'rejected', reason: 'sender_mismatch' },
      { status: 'rejected', reason: 'sender_not_authenticated' },
      { status: 'rejected', reason: 'unknown_reply_address' },
    ]);
  });

  it('posts routed mail into its channel as the admin who set it up', async () => {
    const app = await buildApp({ db, fetchImpl: crewly.fetch });
    const owner = { authorization: `Bearer ${createSession(db, ada.id)}` };
    const refused = await app.inject({ method: 'POST', url: '/api/v1/server/mail/inbound/routes', headers: owner, payload: { address: 'help@example.com', conversationId } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toBe('example.com is not a verified sending domain of this server');

    const created = await app.inject({ method: 'POST', url: '/api/v1/server/mail/inbound/routes', headers: owner, payload: { address: 'Support@Acme.com', conversationId } });
    expect(created.statusCode).toBe(201);
    expect(crewly.routes).toEqual([{ address: 'support@acme.com', target: conversationId }]);

    crewly.queue = [inbound({
      kind: 'route', target: conversationId, recipient: 'support@acme.com', from: { email: 'customer@client.test', name: 'Cus Tomer' },
      subject: 'Invoice', text: 'Where is my invoice?', attachments: [{ name: 'po.pdf', contentType: 'application/pdf', size: 10 }],
    })];
    await pullInboundMail(db, crewly.fetch, app.hub);
    const [posted] = messages();
    expect(posted!.author_id).toBe(ada.id);
    expect(posted!.body).toBe('Email from Cus Tomer <customer@client.test> to support@acme.com: Invoice\n\nWhere is my invoice?\n\nAttachments (not kept): po.pdf');

    const log = await app.inject({ method: 'GET', url: '/api/v1/server/mail/inbound', headers: owner });
    expect(log.json().messages[0]).toMatchObject({ kind: 'route', status: 'delivered', conversationId });
    await app.close();
  });

  it('does not ask Crewly for anything without mail:receive', async () => {
    db.prepare(`UPDATE crewly_connection SET scopes = '["mail:send"]'`).run();
    expect(await replyAddress(db, crewly.fetch, conversationId, ada.id)).toBeUndefined();
    await expect(pullInboundMail(db, crewly.fetch, hub)).rejects.toThrow('mail:receive');
    expect(crewly.addressCalls).toBe(0);
  });
});

describe('quoted reply stripping', () => {
  it('keeps only what was written above the quote', () => {
    expect(stripQuotedReply('Thanks!\r\n\r\nOn Mon, 1 Jan, Crewly <n@crewly.test> wrote:\r\n> hi')).toBe('Thanks!');
    expect(stripQuotedReply('Sure\n-----Original Message-----\nFrom: x')).toBe('Sure');
    expect(stripQuotedReply('> only a quote')).toBe('');
    expect(stripQuotedReply('No quote at all')).toBe('No quote at all');
  });
});
