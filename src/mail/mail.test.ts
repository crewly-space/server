import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSession } from '../auth/session.js';
import { openSqlite, type Database } from '../db/driver.js';
import { encryptDatabaseSecret } from '../db/secrets.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { postmarkTransport, resendTransport, type MailTransport, type SendResult } from './providers.js';
import { MAIL_MAX_ATTEMPTS, MailDisabledError, MailService } from './service.js';
import { sendSmtp } from './smtp.js';

/** An SMTP relay that accepts one message and remembers what it was told. */
function fakeSmtpServer(options: { requireAuth?: string; rejectRecipient?: boolean } = {}) {
  const received: { commands: string[]; data: string } = { commands: [], data: '' };
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let inData = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued as ABC123\r\n');
          } else received.data += `${line}\n`;
          continue;
        }
        received.commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (line.startsWith('AUTH PLAIN')) socket.write(line === `AUTH PLAIN ${options.requireAuth}` ? '235 ok\r\n' : '535 5.7.8 bad credentials\r\n');
        else if (line.startsWith('MAIL FROM')) socket.write('250 ok\r\n');
        else if (line.startsWith('RCPT TO')) socket.write(options.rejectRecipient ? '550 5.1.1 no such user\r\n' : '250 ok\r\n');
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
      }
    });
  });
  return new Promise<{ port: number; received: typeof received; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as net.AddressInfo).port,
      received,
      close: () => server.close(),
    }));
  });
}

describe('SMTP', () => {
  it('authenticates, sends one message and dot-stuffs its body', async () => {
    const token = Buffer.from('\u0000user\u0000pass').toString('base64');
    const relay = await fakeSmtpServer({ requireAuth: token });
    try {
      const accepted = await sendSmtp(
        { host: '127.0.0.1', port: relay.port, security: 'none', username: 'user', password: 'pass' },
        { from: 'crew@example.com', to: 'someone@example.com' },
        'Subject: hi\r\n\r\n.leading dot\r\nbody',
      );
      expect(accepted).toContain('queued as ABC123');
      expect(relay.received.commands).toEqual(expect.arrayContaining([
        `AUTH PLAIN ${token}`, 'MAIL FROM:<crew@example.com>', 'RCPT TO:<someone@example.com>',
      ]));
      expect(relay.received.data).toContain('..leading dot');
    } finally {
      relay.close();
    }
  });

  it('reports a refused login with its code', async () => {
    const relay = await fakeSmtpServer({ requireAuth: 'something-else' });
    try {
      await expect(sendSmtp({ host: '127.0.0.1', port: relay.port, security: 'none', username: 'u', password: 'p' },
        { from: 'a@example.com', to: 'b@example.com' }, 'x')).rejects.toMatchObject({ code: 535 });
    } finally {
      relay.close();
    }
  });
});

describe('HTTP mail providers', () => {
  const mail = { deliveryId: 'd1', from: 'Crew <crew@example.com>', to: 'a@example.com', rendered: { subject: 's', text: 't', html: '<p>t</p>' } };
  const answer = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status });

  it('normalises Resend results', async () => {
    expect(await resendTransport('k', answer(200, { id: 're_1' })).send(mail)).toEqual({ ok: true, providerMessageId: 're_1' });
    expect(await resendTransport('k', answer(401, { message: 'bad key' })).send(mail)).toMatchObject({ ok: false, errorClass: 'auth' });
    expect(await resendTransport('k', answer(429, {})).send(mail)).toMatchObject({ ok: false, errorClass: 'rate_limited' });
    expect(await resendTransport('k', async () => { throw new TypeError('offline'); }).send(mail)).toMatchObject({ ok: false, errorClass: 'network' });
  });

  it('normalises Postmark results, including a 200 that carries an error code', async () => {
    expect(await postmarkTransport('k', answer(200, { MessageID: 'pm_1', ErrorCode: 0 })).send(mail)).toEqual({ ok: true, providerMessageId: 'pm_1' });
    expect(await postmarkTransport('k', answer(200, { ErrorCode: 406, Message: 'inactive recipient' })).send(mail)).toMatchObject({ ok: false, errorClass: 'rejected' });
    expect(await postmarkTransport('k', answer(503, {})).send(mail)).toMatchObject({ ok: false, errorClass: 'provider_unavailable' });
  });
});

describe('mail service', () => {
  let db: Database;
  let outcomes: SendResult[];
  let sent: Array<Parameters<MailTransport['send']>[0]>;
  let service: MailService;

  beforeEach(() => {
    db = openSqlite(':memory:');
    runMigrations(db);
    outcomes = [];
    sent = [];
    const scripted: MailTransport = {
      async send(mail) {
        sent.push(mail);
        return outcomes.shift() ?? { ok: true, providerMessageId: `msg-${sent.length}` };
      },
    };
    service = new MailService(db, { fetchImpl: fetch, transports: { smtp: () => scripted } });
    service.updateSettings({ provider: 'smtp', fromAddress: 'Crew <crew@example.com>', config: { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'u' }, secret: 'pw' }, null);
  });
  afterEach(() => db.close());

  it('renders a template, sends it, and forgets the message once sent', async () => {
    const delivery = await service.send({ to: 'new@example.com', template: { id: 'member.invited', variables: { inviteUrl: 'https://crew.example.com/join#invite=abc', role: 'member' } } });
    expect(delivery).toMatchObject({ status: 'sent', attempts: 1, category: 'member.invited', providerMessageId: 'msg-1', subject: "You're invited to Crewly" });
    expect(sent[0]!.rendered.text).toContain('https://crew.example.com/join#invite=abc');
    expect(sent[0]!.from).toBe('Crew <crew@example.com>');
    expect(db.prepare('SELECT payload_ciphertext FROM mail_deliveries').pluck().get()).toBeNull();
  });

  it('keeps the queued message encrypted', async () => {
    outcomes.push({ ok: false, errorClass: 'network', message: 'down' });
    await service.send({ to: 'a@example.com', template: { id: 'auth.magic_link', variables: { signInUrl: 'https://x/secret-token' } } });
    const stored = db.prepare('SELECT payload_ciphertext FROM mail_deliveries').pluck().get() as string;
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain('secret-token');
  });

  it('retries retryable failures on schedule, then gives up visibly', async () => {
    for (let i = 0; i < MAIL_MAX_ATTEMPTS; i += 1) outcomes.push({ ok: false, errorClass: 'provider_unavailable', message: 'busy' });
    const first = await service.send({ to: 'a@example.com', template: { id: 'mail.test', variables: {} } });
    expect(first).toMatchObject({ status: 'retrying', attempts: 1, errorClass: 'provider_unavailable' });
    expect(new Date(first.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now() + 50_000);

    // Nothing is due yet.
    expect(await service.retryDue()).toBe(0);
    let at = Date.now();
    for (let attempt = 2; attempt <= MAIL_MAX_ATTEMPTS; attempt += 1) {
      at += 3 * 60 * 60 * 1000;
      expect(await service.retryDue(new Date(at))).toBe(1);
    }
    const [last] = service.listDeliveries({ limit: 1 });
    expect(last).toMatchObject({ status: 'failed', attempts: MAIL_MAX_ATTEMPTS, nextAttemptAt: null });
  });

  it('fails a non-retryable error at once, and lets an admin retry it after fixing the cause', async () => {
    outcomes.push({ ok: false, errorClass: 'auth', message: 'bad password' });
    const failed = await service.send({ to: 'a@example.com', template: { id: 'mail.test', variables: {} } });
    expect(failed).toMatchObject({ status: 'failed', errorClass: 'auth', lastError: 'bad password' });
    expect((await service.retry(failed.id))!.status).toBe('sent');
  });

  it('sends once per idempotency key', async () => {
    const first = await service.send({ to: 'a@example.com', template: { id: 'mail.test', variables: {} }, idempotencyKey: 'k1' });
    const again = await service.send({ to: 'a@example.com', template: { id: 'mail.test', variables: {} }, idempotencyKey: 'k1' });
    expect(again.id).toBe(first.id);
    expect(sent).toHaveLength(1);
  });

  it('bounds custom content and refuses header injection', async () => {
    await expect(service.send({ to: 'a@example.com', content: { subject: 'x'.repeat(201), text: 't' } })).rejects.toThrow('size limit');
    await service.send({ to: 'a@example.com', content: { subject: 'Hello', text: '<b>hi</b>' }, headers: { 'Reply-To': 'r@example.com', Bcc: 'x@evil.test' } });
    expect(sent[0]!.headers).toEqual({ 'Reply-To': 'r@example.com' });
    expect(sent[0]!.rendered.html).toContain('&lt;b&gt;hi&lt;/b&gt;');
  });

  it('refuses when disabled, and never returns the stored secret', async () => {
    expect(JSON.stringify(service.settings())).not.toContain('pw');
    expect(service.settings().hasSecret).toBe(true);
    // Switching provider drops the key that belonged to the old one.
    service.updateSettings({ provider: 'disabled' }, null);
    expect(service.settings().hasSecret).toBe(false);
    await expect(service.send({ to: 'a@example.com', template: { id: 'mail.test', variables: {} } })).rejects.toBeInstanceOf(MailDisabledError);
    expect(() => service.updateSettings({ provider: 'resend', fromAddress: 'a@example.com' }, null)).toThrow('needs an API key');
  });
});

describe('Crewly Mail', () => {
  let db: Database;
  beforeEach(() => {
    db = openSqlite(':memory:');
    runMigrations(db);
  });
  afterEach(() => db.close());

  const connect = (scopes: string[]) => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO crewly_connection (id, cloud_url, status, instance_id, credential_ciphertext, credential_version, scopes, connected_at, updated_at)
       VALUES (1, 'https://crewly.test', 'connected', 'inst-1', ?, 1, ?, ?, ?)`,
    ).run(encryptDatabaseSecret(db, 'crewly_inst_x'), JSON.stringify(scopes), now, now);
  };

  it('needs the Crewly connection with mail:send', async () => {
    const service = new MailService(db, { fetchImpl: fetch });
    service.updateSettings({ provider: 'crewly' }, null);
    const delivery = await service.send({ to: 'a@example.com', template: { id: 'mail.test', variables: {} } });
    expect(delivery).toMatchObject({ status: 'failed', errorClass: 'not_permitted' });
  });

  it('sends the template id and variables with the instance credential and an idempotency key', async () => {
    connect(['mail:send']);
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const service = new MailService(db, {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
        return new Response(JSON.stringify({ id: 'cm_1', status: 'sent' }), { status: 201 });
      },
    });
    service.updateSettings({ provider: 'crewly' }, null);
    const delivery = await service.send({ to: 'a@example.com', template: { id: 'mail.test', variables: {} } });
    expect(delivery).toMatchObject({ status: 'sent', providerMessageId: 'cm_1', provider: 'crewly' });
    expect(calls[0]!.url).toBe('https://crewly.test/api/v1/instance/mail');
    expect(calls[0]!.headers.authorization).toBe('Bearer crewly_inst_x');
    expect(calls[0]!.headers['idempotency-key']).toBe(delivery.id);
    expect(calls[0]!.body).toEqual({ to: 'a@example.com', template: { id: 'mail.test', variables: {} } });
  });
});

describe('mail routes and invites', () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: { authorization: string };
  let member: { authorization: string };
  let sent: string[];

  beforeEach(async () => {
    db = openSqlite(':memory:');
    runMigrations(db);
    sent = [];
    const mail = new MailService(db, {
      fetchImpl: fetch,
      transports: { smtp: () => ({ async send(message) { sent.push(message.rendered.text); return { ok: true, providerMessageId: 'id' }; } }) },
    });
    app = await buildApp({ db, mail });
    owner = { authorization: `Bearer ${createSession(db, createUser(db, { email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'owner' }).id)}` };
    member = { authorization: `Bearer ${createSession(db, createUser(db, { email: 'm@example.com', displayName: 'M', passwordHash: 'x', role: 'member' }).id)}` };
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const configure = () => app.inject({
    method: 'PUT', url: '/api/v1/server/mail', headers: owner,
    payload: { provider: 'smtp', fromAddress: 'crew@example.com', config: { host: 'smtp.example.com', port: 587, security: 'starttls', username: 'u' }, secret: 'hunter2hunter2' },
  });

  it('configures a provider without ever returning its secret, and test-sends', async () => {
    const saved = await configure();
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('hunter2');
    const read = await app.inject({ method: 'GET', url: '/api/v1/server/mail', headers: owner });
    expect(read.json()).toMatchObject({ settings: { provider: 'smtp', hasSecret: true, config: { host: 'smtp.example.com' } }, crewlyMailAvailable: false });
    expect(read.body).not.toContain('hunter2');

    const test = await app.inject({ method: 'POST', url: '/api/v1/server/mail/test', headers: owner, payload: { to: 'me@example.com' } });
    expect(test.json().delivery).toMatchObject({ status: 'sent', category: 'mail.test' });
    const log = await app.inject({ method: 'GET', url: '/api/v1/server/mail/deliveries', headers: owner });
    expect(log.json().deliveries).toHaveLength(1);
  });

  it('rejects incomplete settings with a reason', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/server/mail', headers: owner, payload: { provider: 'smtp', fromAddress: 'a@example.com' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe('SMTP needs a host and a port');
  });

  it('is for owners and admins only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/server/mail', headers: member })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/server/mail/test', headers: member, payload: { to: 'a@example.com' } })).statusCode).toBe(403);
  });

  it('emails an invite through the configured provider', async () => {
    const refused = await app.inject({ method: 'POST', url: '/api/v1/invites', headers: owner, payload: { email: 'new@example.com' } });
    expect(refused.statusCode).toBe(409);
    expect(db.prepare('SELECT COUNT(*) FROM invites').pluck().get()).toBe(0);

    await configure();
    const invited = await app.inject({ method: 'POST', url: '/api/v1/invites', headers: { ...owner, host: 'crew.example.com' }, payload: { email: 'new@example.com' } });
    expect(invited.statusCode).toBe(201);
    const { invite, delivery } = invited.json();
    expect(delivery).toMatchObject({ status: 'sent', recipient: 'new@example.com', category: 'member.invited' });
    expect(sent[0]).toContain(`http://crew.example.com/join#invite=${invite.code}`);
  });
});
