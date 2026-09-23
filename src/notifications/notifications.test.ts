import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../agents/repository.js';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { createConversation } from '../conversations/repository.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { enqueueJob } from '../jobs/repository.js';
import { JobRunner } from '../jobs/runner.js';
import type { MailTransport, SendResult } from '../mail/providers.js';
import { MailService } from '../mail/service.js';
import { createProviderConfig } from '../providers/repository.js';
import { createUser } from '../users/repository.js';
import { emitNotification, notificationServiceFor, type NotificationChannel } from './service.js';

describe('notification pipeline', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sent: Array<{ to: string; subject: string; text: string; headers?: Record<string, string> }>;
  let mailOutcomes: SendResult[];
  let ada: { id: string };
  let grace: { id: string };
  let asAda: { authorization: string };
  let asGrace: { authorization: string };
  let conversationId: string;

  beforeEach(async () => {
    db = openSqlite(':memory:');
    runMigrations(db);
    sent = [];
    mailOutcomes = [];
    const transport: MailTransport = {
      async send(mail) {
        sent.push({ to: mail.to, subject: mail.rendered.subject, text: mail.rendered.text, headers: mail.headers });
        return mailOutcomes.shift() ?? { ok: true, providerMessageId: 'id' };
      },
    };
    const mail = new MailService(db, { fetchImpl: fetch, transports: { smtp: () => transport } });
    mail.updateSettings({ provider: 'smtp', fromAddress: 'crew@example.com', config: { host: 'smtp.example.com', port: 587, security: 'starttls' } }, null);
    app = await buildApp({ db, mail, publicUrl: 'https://crew.example.com', respond: async () => ({ body: 'Done: the build is green.' }) });
    ada = createUser(db, { email: 'ada@example.com', displayName: 'Ada', passwordHash: 'x', role: 'owner' });
    grace = createUser(db, { email: 'grace@example.com', displayName: 'Grace', passwordHash: 'x', role: 'member' });
    asAda = { authorization: `Bearer ${createSession(db, ada.id)}` };
    asGrace = { authorization: `Bearer ${createSession(db, grace.id)}` };
    conversationId = createConversation(db, {
      kind: 'group', name: 'builds',
      participants: [{ participantId: ada.id, participantType: 'user' }, { participantId: grace.id, participantType: 'user' }],
    }).id;
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const mention = (body: string) => app.inject({
    method: 'POST', url: `/api/v1/conversations/${conversationId}/messages`, headers: asAda,
    payload: { body, mentions: [{ targetId: grace.id, targetType: 'user' }] },
  });
  const feed = async (headers = asGrace) => (await app.inject({ method: 'GET', url: '/api/v1/notifications', headers })).json();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('tells a mentioned person in-app and by email from the same decision, with a link back', async () => {
    expect((await mention('@Grace can you look at the build?')).statusCode).toBe(201);
    await settle();
    const { notifications, unread } = await feed();
    expect(unread).toBe(1);
    expect(notifications[0]).toMatchObject({ type: 'mention.created', title: 'Ada mentioned you in builds', body: '@Grace can you look at the build?', conversationId });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'grace@example.com', subject: 'Ada mentioned you in builds' });
    expect(sent[0]!.text).toContain(`https://crew.example.com/?conversation=${conversationId}`);
    // The author is not told about their own message.
    expect((await feed(asAda)).notifications).toEqual([]);
  });

  it('follows a changed preference, per channel', async () => {
    const changed = await app.inject({ method: 'PUT', url: '/api/v1/notifications/preferences', headers: asGrace, payload: { type: 'mention.created', channel: 'email', mode: 'off' } });
    expect(changed.json().preferences.find((entry: { type: string }) => entry.type === 'mention.created').channels).toEqual({ in_app: 'instant', email: 'off' });
    await mention('@Grace ping');
    await settle();
    expect((await feed()).notifications).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it('refuses to turn off mandatory events, or a channel an event does not use', async () => {
    const mandatory = await app.inject({ method: 'PUT', url: '/api/v1/notifications/preferences', headers: asGrace, payload: { type: 'auth.magic_link', channel: 'email', mode: 'off' } });
    expect(mandatory.statusCode).toBe(400);
    expect(mandatory.json().message).toBe('Sign-in links cannot be turned off');
    const wrongChannel = await app.inject({ method: 'PUT', url: '/api/v1/notifications/preferences', headers: asGrace, payload: { type: 'member.invited', channel: 'in_app', mode: 'off' } });
    expect(wrongChannel.statusCode).toBe(400);
    const listed = (await app.inject({ method: 'GET', url: '/api/v1/notifications/preferences', headers: asGrace })).json().preferences;
    expect(listed.find((entry: { type: string }) => entry.type === 'auth.magic_link')).toMatchObject({ mandatory: true, channels: { email: 'instant' } });
  });

  it('notifies once for a retried event', async () => {
    const event = { type: 'server.alert' as const, recipients: [{ userId: ada.id }], dedupeKey: 'alert-1', title: 'Disk almost full', body: '95% used' };
    await emitNotification(db, event);
    await emitNotification(db, event);
    expect((await feed(asAda)).notifications).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('turns a burst about one conversation into one notification per channel', async () => {
    await mention('@Grace one');
    await mention('@Grace two');
    await mention('@Grace three');
    await settle();
    expect((await feed()).notifications).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const skipped = notificationServiceFor(db)!.listDeliveries({ status: 'skipped', limit: 10 });
    expect(skipped.map((delivery) => delivery.reason)).toEqual(['collapsed', 'collapsed', 'collapsed', 'collapsed']);
  });

  it('records a failed email and still delivers in-app', async () => {
    mailOutcomes.push({ ok: false, errorClass: 'auth', message: '535 bad credentials' });
    await emitNotification(db, { type: 'server.alert', recipients: [{ userId: ada.id }], dedupeKey: 'alert-2', title: 'Alert', body: 'Something' });
    const deliveries = (await app.inject({ method: 'GET', url: '/api/v1/server/notifications/deliveries', headers: asAda })).json().deliveries;
    expect(deliveries.find((delivery: { channel: string }) => delivery.channel === 'email')).toMatchObject({ status: 'failed', lastError: '535 bad credentials' });
    expect(deliveries.find((delivery: { channel: string }) => delivery.channel === 'in_app')).toMatchObject({ status: 'delivered' });
    expect((await app.inject({ method: 'GET', url: '/api/v1/server/notifications/deliveries', headers: asGrace })).statusCode).toBe(403);
  });

  it('skips email, not the notification, when mail is off', async () => {
    app.mail.updateSettings({ provider: 'disabled' }, null);
    await emitNotification(db, { type: 'server.alert', recipients: [{ userId: ada.id }], dedupeKey: 'alert-3', title: 'Alert', body: 'Something' });
    expect((await feed(asAda)).notifications).toHaveLength(1);
    const email = notificationServiceFor(db)!.listDeliveries({ limit: 10 }).find((delivery) => delivery.channel === 'email');
    expect(email).toMatchObject({ status: 'skipped', reason: 'mail_disabled' });
  });

  it('retries a failed in-app delivery on its schedule', async () => {
    const service = notificationServiceFor(db)!;
    let failures = 1;
    const flaky: NotificationChannel = {
      id: 'in_app',
      async deliver() {
        if (failures-- > 0) throw new Error('database is locked');
        return { status: 'delivered' };
      },
    };
    (service as unknown as { channels: Map<string, NotificationChannel> }).channels.set('in_app', flaky);
    const [first] = await service.emit({ type: 'server.alert', recipients: [{ userId: ada.id }], dedupeKey: 'alert-4', title: 'A', body: 'B' });
    expect(first).toMatchObject({ channel: 'in_app', status: 'pending', lastError: 'database is locked' });
    expect(await service.retryDue(new Date(Date.now() + 60_000))).toBe(1);
    expect(service.listDeliveries({ limit: 10 }).find((delivery) => delivery.id === first!.id)).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('marks notifications read', async () => {
    await mention('@Grace one');
    await settle();
    const [notification] = (await feed()).notifications;
    await app.inject({ method: 'POST', url: `/api/v1/notifications/${notification.id}/read`, headers: asGrace });
    expect((await feed()).unread).toBe(0);
    // Somebody else's notification is not theirs to mark.
    await emitNotification(db, { type: 'server.alert', recipients: [{ userId: ada.id }], dedupeKey: 'alert-5', title: 'A', body: 'B' });
    const [adas] = (await feed(asAda)).notifications;
    await app.inject({ method: 'POST', url: `/api/v1/notifications/${adas.id}/read`, headers: asGrace });
    expect((await feed(asAda)).unread).toBe(1);
    await app.inject({ method: 'POST', url: '/api/v1/notifications/read-all', headers: asAda });
    expect((await feed(asAda)).unread).toBe(0);
  });

  it('tells the people in a conversation when an agent replies there', async () => {
    createProviderConfig(db, { id: 'anthropic', kind: 'anthropic', apiKey: 'k' });
    const agent = createAgent(db, {
      ownerUserId: ada.id, name: 'Builder', personality: 'Builds',
      modelPolicy: { defaultProviderId: 'anthropic', defaultModel: 'claude-sonnet-5' },
      permissions: { tools: [], canMessageAgents: false, canApproveOwnActions: false },
    });
    const dm = createConversation(db, { kind: 'dm', name: null, participants: [{ participantId: ada.id, participantType: 'user' }, { participantId: agent.id, participantType: 'agent' }] });
    await app.inject({ method: 'POST', url: `/api/v1/conversations/${dm.id}/messages`, headers: asAda, payload: { body: 'Is the build green?' } });
    for (let i = 0; i < 50 && (await feed(asAda)).notifications.length === 0; i += 1) await settle();
    expect((await feed(asAda)).notifications[0]).toMatchObject({ type: 'agent.completed', title: 'Builder replied', body: 'Done: the build is green.' });
    // Off by email unless chosen.
    expect(sent).toEqual([]);
  });

  it('alerts administrators when background work runs out of retries', async () => {
    enqueueJob(db, { type: 'reindex', payload: {} });
    const runner = new JobRunner(db, { reindex: async () => { throw new Error('index is corrupt'); } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      db.prepare("UPDATE jobs SET run_at = '2000-01-01T00:00:00.000Z'").run();
      await runner.runOnce();
    }
    await settle();
    const alerts = (await feed(asAda)).notifications;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'server.alert', title: 'Background work failed: reindex', body: 'index is corrupt' });
    // Grace is a member, not an admin.
    expect((await feed()).notifications).toEqual([]);
  });
});
