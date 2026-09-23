import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import type { MailTransport, SendResult } from '../mail/providers.js';
import { MailService } from '../mail/service.js';
import { createUser } from '../users/repository.js';
import { lastScheduledAt, sendDueDigests } from './digest.js';
import { emitNotification, notificationServiceFor } from './service.js';

describe('notification digests', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sent: Array<{ to: string; subject: string; text: string; html: string }>;
  let outcomes: SendResult[];
  let ada: { id: string };
  let asAda: { authorization: string };
  const inTwoDays = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

  beforeEach(async () => {
    db = openSqlite(':memory:');
    runMigrations(db);
    sent = [];
    outcomes = [];
    const transport: MailTransport = {
      async send(mail) {
        sent.push({ to: mail.to, ...mail.rendered });
        return outcomes.shift() ?? { ok: true, providerMessageId: 'id' };
      },
    };
    const mail = new MailService(db, { fetchImpl: fetch, transports: { smtp: () => transport } });
    mail.updateSettings({ provider: 'smtp', fromAddress: 'crew@example.com', config: { host: 'smtp.example.com', port: 587, security: 'starttls' } }, null);
    app = await buildApp({ db, mail, publicUrl: 'https://crew.example.com' });
    ada = createUser(db, { email: 'ada@example.com', displayName: 'Ada', passwordHash: 'x', role: 'owner' });
    asAda = { authorization: `Bearer ${createSession(db, ada.id)}` };
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const prefer = (type: string, mode: string, channel = 'email') =>
    app.inject({ method: 'PUT', url: '/api/v1/notifications/preferences', headers: asAda, payload: { type, channel, mode } });
  const agentReply = (n: number, conversation = 'c1') => emitNotification(db, {
    type: 'agent.needs_attention', recipients: [{ userId: ada.id }], dedupeKey: `run-${conversation}-${n}`,
    collapseKey: `conversation:${conversation}`, title: `Builder could not finish (${n})`, body: `Attempt ${n} failed`, conversationId: conversation,
  });
  const digestNow = () => sendDueDigests(db, notificationServiceFor(db)!, app.mail, inTwoDays());

  it('holds digest email until the scheduled time, and still notifies in-app at once', async () => {
    expect((await prefer('agent.needs_attention', 'digest')).statusCode).toBe(200);
    await agentReply(1);
    expect(sent).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: asAda })).json().unread).toBe(1);
    // Not yet time: the slot that has passed came before the event.
    expect(await sendDueDigests(db, notificationServiceFor(db)!, app.mail)).toBe(0);
    expect(await digestNow()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Your Crewly digest: 1 update');
  });

  it('summarises repeats and links back, and sends each slot once', async () => {
    await prefer('agent.needs_attention', 'digest');
    for (let n = 1; n <= 3; n += 1) await agentReply(n, 'c1');
    await agentReply(1, 'c2');
    await digestNow();
    await digestNow();
    expect(sent).toHaveLength(1);
    const [digest] = sent;
    expect(digest!.subject).toBe('Your Crewly digest: 4 updates');
    expect(digest!.text).toContain('Builder could not finish (3) (and 2 more like it)');
    expect(digest!.text).toContain('https://crew.example.com/?conversation=c1');
    expect(digest!.html).toContain('<a href="https://crew.example.com/?conversation=c2">Open in Crewly</a>');
    const delivered = notificationServiceFor(db)!.listDeliveries({ status: 'delivered', limit: 20 }).filter((entry) => entry.channel === 'email');
    expect(delivered).toHaveLength(4);
    expect(delivered.every((entry) => entry.reason?.startsWith('digest:'))).toBe(true);
  });

  it('never delays mandatory or instant events', async () => {
    const mandatory = await prefer('auth.magic_link', 'digest');
    expect(mandatory.statusCode).toBe(400);
    expect((await prefer('agent.needs_attention', 'digest', 'in_app')).statusCode).toBe(400);
    await emitNotification(db, {
      type: 'auth.magic_link', recipients: [{ email: 'ada@example.com' }], dedupeKey: 'magic-1', title: 'Sign in', body: 'Sign in',
      template: { id: 'auth.magic_link', variables: { signInUrl: 'https://crew.example.com/sign-in?t=x' } },
    });
    await agentReply(1);
    expect(sent.map((mail) => mail.subject)).toEqual(['Sign in to Crewly', 'Builder could not finish (1)']);
  });

  it('applies a changed preference to events still waiting', async () => {
    await prefer('agent.needs_attention', 'digest');
    await prefer('server.alert', 'digest');
    await agentReply(1);
    await emitNotification(db, { type: 'server.alert', recipients: [{ userId: ada.id }], dedupeKey: 'alert-1', title: 'Disk full', body: '99%' });
    await prefer('server.alert', 'off');
    await prefer('agent.needs_attention', 'instant');
    await digestNow();
    // Turned off: dropped. Made instant: it was already waiting, so it comes in this digest.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Builder could not finish (1)');
    expect(sent[0]!.text).not.toContain('Disk full');
    const skipped = notificationServiceFor(db)!.listDeliveries({ status: 'skipped', limit: 10 });
    expect(skipped.find((entry) => entry.eventType === 'server.alert' && entry.channel === 'email')?.reason).toBe('preference_changed');
  });

  it('retries a failed digest through the mail gateway and settles the events with it', async () => {
    await prefer('agent.needs_attention', 'digest');
    await agentReply(1);
    outcomes.push({ ok: false, errorClass: 'provider_unavailable', message: 'busy' });
    await digestNow();
    const service = notificationServiceFor(db)!;
    expect(service.listDeliveries({ limit: 10 }).find((entry) => entry.channel === 'email')).toMatchObject({ status: 'pending' });
    await app.mail.retryDue(new Date(Date.now() + 10 * 60_000));
    await service.retryDue();
    expect(service.listDeliveries({ limit: 10 }).find((entry) => entry.channel === 'email')).toMatchObject({ status: 'delivered' });
    expect(sent).toHaveLength(2);
  });

  it('lets a person choose the schedule', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/notifications/digest', headers: asAda })).json().schedule).toEqual({ frequency: 'daily', hourUtc: 8, weekday: null });
    const weekly = await app.inject({ method: 'PUT', url: '/api/v1/notifications/digest', headers: asAda, payload: { frequency: 'weekly', hourUtc: 17, weekday: 5 } });
    expect(weekly.json().schedule).toEqual({ frequency: 'weekly', hourUtc: 17, weekday: 5 });
  });
});

describe('digest schedule', () => {
  it('finds the last daily slot', () => {
    expect(lastScheduledAt({ frequency: 'daily', hourUtc: 8, weekday: null }, new Date('2026-09-23T09:00:00Z')).toISOString()).toBe('2026-09-23T08:00:00.000Z');
    expect(lastScheduledAt({ frequency: 'daily', hourUtc: 8, weekday: null }, new Date('2026-09-23T07:59:00Z')).toISOString()).toBe('2026-09-22T08:00:00.000Z');
  });

  it('finds the last weekly slot', () => {
    // 2026-09-23 is a Wednesday.
    expect(lastScheduledAt({ frequency: 'weekly', hourUtc: 17, weekday: 5 }, new Date('2026-09-23T12:00:00Z')).toISOString()).toBe('2026-09-18T17:00:00.000Z');
    expect(lastScheduledAt({ frequency: 'weekly', hourUtc: 17, weekday: 3 }, new Date('2026-09-23T18:00:00Z')).toISOString()).toBe('2026-09-23T17:00:00.000Z');
    expect(lastScheduledAt({ frequency: 'weekly', hourUtc: 17, weekday: 3 }, new Date('2026-09-23T16:00:00Z')).toISOString()).toBe('2026-09-16T17:00:00.000Z');
  });
});
