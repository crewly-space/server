import { randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { decryptDatabaseSecret, encryptDatabaseSecret } from '../db/secrets.js';
import {
  crewlyTransport,
  postmarkTransport,
  resendTransport,
  RETRYABLE,
  smtpTransport,
  type MailErrorClass,
  type MailProvider,
  type MailTransport,
  type OutgoingMail,
} from './providers.js';
import type { SmtpConfig } from './smtp.js';
import { renderTemplate, type MailTemplateId, type RenderedMail } from './templates.js';

/*
 * The one way this server sends email.
 *
 * Feature code hands over a recipient and either a template id with its
 * variables (system mail) or bounded content of its own, and never learns
 * which provider is configured. Every attempt is recorded, failures are
 * classified the same way for every provider, and retries follow one policy.
 */

/**
 * The retry policy. A retryable failure is tried again after each delay in
 * turn; after the last, the delivery is failed and stays visible to admins.
 * Non-retryable failures (auth, rejected, not permitted, config) fail at once.
 */
export const MAIL_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
export const MAIL_MAX_ATTEMPTS = MAIL_RETRY_DELAYS_MS.length + 1;

/** The bounded path for mail that is not a system template. */
export const CUSTOM_MAIL_LIMITS = { subject: 200, text: 20_000, html: 100_000 } as const;

export interface MailSettingsView {
  provider: MailProvider;
  fromAddress: string | null;
  /** Non-secret settings only, e.g. SMTP host and username. */
  config: Record<string, unknown>;
  /** Whether a password or API key is stored. Its value is never returned. */
  hasSecret: boolean;
  updatedAt: string | null;
}

export interface MailSettingsInput {
  provider: MailProvider;
  fromAddress?: string | null;
  config?: Record<string, unknown>;
  /** Replaces the stored password/API key; omit to keep it. */
  secret?: string;
}

export interface MailMessage {
  to: string;
  template?: { id: MailTemplateId; variables: Record<string, string> };
  content?: { subject: string; text: string; html?: string };
  /** A repeated send with the same key returns the first delivery instead of sending twice. */
  idempotencyKey?: string;
  /** Extra headers such as Reply-To. Never used for From, To or Subject. */
  headers?: Record<string, string>;
}

export interface MailDelivery {
  id: string;
  category: string;
  recipient: string;
  subject: string;
  provider: MailProvider;
  status: 'queued' | 'sent' | 'retrying' | 'failed';
  attempts: number;
  errorClass: MailErrorClass | null;
  lastError: string | null;
  providerMessageId: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  sentAt: string | null;
}

export class MailDisabledError extends Error {
  constructor() {
    super('Outbound email is disabled on this server');
  }
}
export class MailSettingsError extends Error {}

interface SettingsRow {
  provider: MailProvider;
  from_address: string | null;
  config: string;
  secret_ciphertext: string | null;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  idempotency_key: string | null;
  category: string;
  recipient: string;
  subject: string;
  payload_ciphertext: string | null;
  provider: MailProvider;
  status: MailDelivery['status'];
  attempts: number;
  error_class: MailErrorClass | null;
  last_error: string | null;
  provider_message_id: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

/** What is kept (encrypted) so a failed attempt can be tried again. */
interface StoredPayload {
  from: string | null;
  rendered: RenderedMail;
  template?: MailMessage['template'];
  headers?: Record<string, string>;
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;
const FORBIDDEN_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'content-type', 'mime-version', 'message-id', 'date']);

const toDelivery = (row: DeliveryRow): MailDelivery => ({
  id: row.id,
  category: row.category,
  recipient: row.recipient,
  subject: row.subject,
  provider: row.provider,
  status: row.status,
  attempts: row.attempts,
  errorClass: row.error_class,
  lastError: row.last_error,
  providerMessageId: row.provider_message_id,
  nextAttemptAt: row.next_attempt_at,
  createdAt: row.created_at,
  sentAt: row.sent_at,
});

function readSmtpConfig(config: Record<string, unknown>, password: string | undefined): SmtpConfig {
  const host = typeof config.host === 'string' ? config.host : '';
  const port = Number(config.port);
  const security = config.security;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) throw new MailSettingsError('SMTP needs a host and a port');
  if (security !== 'tls' && security !== 'starttls' && security !== 'none') throw new MailSettingsError('SMTP security must be tls, starttls or none');
  const username = typeof config.username === 'string' && config.username ? config.username : undefined;
  return { host, port, security, username, password };
}

export class MailService {
  constructor(
    private readonly db: Database,
    private readonly options: {
      fetchImpl: typeof fetch;
      /** Replaces the transport for a provider; tests use it to stand in for SMTP. */
      transports?: Partial<Record<MailProvider, (settings: MailSettingsView, secret: string | undefined) => MailTransport>>;
    },
  ) {}

  private settingsRow(): SettingsRow | undefined {
    return this.db.prepare('SELECT * FROM mail_settings WHERE id = 1').get() as SettingsRow | undefined;
  }

  settings(): MailSettingsView {
    const row = this.settingsRow();
    if (!row) return { provider: 'disabled', fromAddress: null, config: {}, hasSecret: false, updatedAt: null };
    return {
      provider: row.provider,
      fromAddress: row.from_address,
      config: JSON.parse(row.config),
      hasSecret: row.secret_ciphertext !== null,
      updatedAt: row.updated_at,
    };
  }

  enabled(): boolean {
    return this.settings().provider !== 'disabled';
  }

  updateSettings(input: MailSettingsInput, userId: string | null): MailSettingsView {
    const current = this.settingsRow();
    const config = input.config ?? (current?.provider === input.provider ? JSON.parse(current.config) : {});
    // A key belongs to the provider it was entered for; switching provider drops it.
    const keepSecret = input.secret === undefined && current?.provider === input.provider;
    const secretCiphertext = input.secret !== undefined
      ? encryptDatabaseSecret(this.db, input.secret)
      : keepSecret ? current?.secret_ciphertext ?? null : null;
    if (input.provider === 'smtp') readSmtpConfig(config, undefined);
    if ((input.provider === 'resend' || input.provider === 'postmark') && !secretCiphertext) {
      throw new MailSettingsError(`${input.provider === 'resend' ? 'Resend' : 'Postmark'} needs an API key`);
    }
    const fromAddress = input.fromAddress === undefined ? current?.from_address ?? null : input.fromAddress;
    if (['smtp', 'resend', 'postmark'].includes(input.provider) && !fromAddress) {
      throw new MailSettingsError('A from address is required for this provider');
    }
    this.db.prepare(
      `INSERT INTO mail_settings (id, provider, from_address, config, secret_ciphertext, updated_by, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, from_address = excluded.from_address,
         config = excluded.config, secret_ciphertext = excluded.secret_ciphertext,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(input.provider, fromAddress, JSON.stringify(config), secretCiphertext, userId, new Date().toISOString());
    return this.settings();
  }

  private transport(): MailTransport {
    const row = this.settingsRow();
    const settings = this.settings();
    const secret = row?.secret_ciphertext ? decryptDatabaseSecret(this.db, row.secret_ciphertext) : undefined;
    const override = this.options.transports?.[settings.provider];
    if (override) return override(settings, secret);
    switch (settings.provider) {
      case 'crewly': return crewlyTransport(this.db, this.options.fetchImpl);
      case 'resend': return resendTransport(secret ?? '', this.options.fetchImpl);
      case 'postmark': return postmarkTransport(secret ?? '', this.options.fetchImpl);
      case 'smtp': return smtpTransport(readSmtpConfig(settings.config, secret));
      case 'disabled': throw new MailDisabledError();
    }
  }

  private render(message: MailMessage): { rendered: RenderedMail; category: string } {
    if (message.template) {
      const variables = { serverName: 'Crewly', ...message.template.variables };
      return { rendered: renderTemplate(message.template.id, variables), category: message.template.id };
    }
    const content = message.content;
    if (!content) throw new Error('a message needs a template or content');
    if (content.subject.length > CUSTOM_MAIL_LIMITS.subject || content.text.length > CUSTOM_MAIL_LIMITS.text || (content.html?.length ?? 0) > CUSTOM_MAIL_LIMITS.html) {
      throw new MailSettingsError('Custom mail content is over the size limit');
    }
    const escaped = content.text.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!);
    return {
      rendered: { subject: content.subject, text: content.text, html: content.html ?? `<pre style="font-family:inherit;white-space:pre-wrap">${escaped}</pre>` },
      category: 'custom',
    };
  }

  /**
   * Records the message and makes the first attempt. Resolves with the
   * delivery whatever happened -- a failure is a state to inspect, not an
   * exception -- except when mail is disabled, which callers must decide about.
   */
  async send(message: MailMessage): Promise<MailDelivery> {
    if (!EMAIL.test(message.to)) throw new MailSettingsError('That is not an email address');
    const settings = this.settings();
    if (settings.provider === 'disabled') throw new MailDisabledError();
    if (message.idempotencyKey) {
      const existing = this.db.prepare('SELECT * FROM mail_deliveries WHERE idempotency_key = ?').get(message.idempotencyKey) as DeliveryRow | undefined;
      if (existing) return toDelivery(existing);
    }
    const headers = message.headers
      ? Object.fromEntries(Object.entries(message.headers).filter(([name]) => !FORBIDDEN_HEADERS.has(name.toLowerCase())))
      : undefined;
    const { rendered, category } = this.render(message);
    const payload: StoredPayload = { from: settings.fromAddress, rendered, template: message.template, headers };
    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.db.prepare(
        `INSERT INTO mail_deliveries (id, idempotency_key, category, recipient, subject, payload_ciphertext, provider, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      ).run(id, message.idempotencyKey ?? null, category, message.to, rendered.subject,
        encryptDatabaseSecret(this.db, JSON.stringify(payload)), settings.provider, now, now);
    } catch (error) {
      // Two concurrent sends with one key: the other one won, and that is the delivery.
      if (message.idempotencyKey && error instanceof Error && error.message.includes('UNIQUE')) {
        return toDelivery(this.db.prepare('SELECT * FROM mail_deliveries WHERE idempotency_key = ?').get(message.idempotencyKey) as DeliveryRow);
      }
      throw error;
    }
    return this.attempt(id);
  }

  /** One attempt at a queued or retrying delivery, through whatever provider is configured now. */
  private async attempt(id: string): Promise<MailDelivery> {
    const row = this.db.prepare('SELECT * FROM mail_deliveries WHERE id = ?').get(id) as DeliveryRow;
    if (!row.payload_ciphertext || row.status === 'sent') return toDelivery(row);
    const payload = JSON.parse(decryptDatabaseSecret(this.db, row.payload_ciphertext)) as StoredPayload;
    const provider = this.settings().provider;
    let result: Awaited<ReturnType<MailTransport['send']>>;
    try {
      const outgoing: OutgoingMail = { deliveryId: row.id, from: this.settings().fromAddress ?? payload.from, to: row.recipient, rendered: payload.rendered, template: payload.template, headers: payload.headers };
      result = await this.transport().send(outgoing);
    } catch (error) {
      result = error instanceof MailDisabledError
        ? { ok: false, errorClass: 'config', message: error.message }
        : error instanceof MailSettingsError
          ? { ok: false, errorClass: 'config', message: error.message }
          : { ok: false, errorClass: 'network', message: error instanceof Error ? error.message : 'send failed' };
    }
    const attempts = row.attempts + 1;
    const now = new Date();
    if (result.ok) {
      this.db.prepare(
        `UPDATE mail_deliveries SET status = 'sent', attempts = ?, provider = ?, provider_message_id = ?, error_class = NULL,
           last_error = NULL, next_attempt_at = NULL, payload_ciphertext = NULL, sent_at = ?, updated_at = ? WHERE id = ?`,
      ).run(attempts, provider, result.providerMessageId, now.toISOString(), now.toISOString(), id);
    } else {
      const retry = RETRYABLE.has(result.errorClass) && attempts < MAIL_MAX_ATTEMPTS;
      this.db.prepare(
        `UPDATE mail_deliveries SET status = ?, attempts = ?, provider = ?, error_class = ?, last_error = ?, next_attempt_at = ?,
           payload_ciphertext = ?, updated_at = ? WHERE id = ?`,
      ).run(
        retry ? 'retrying' : 'failed',
        attempts,
        provider,
        result.errorClass,
        result.message.slice(0, 500),
        retry ? new Date(now.getTime() + MAIL_RETRY_DELAYS_MS[attempts - 1]!).toISOString() : null,
        // Kept after a permanent failure too, so an admin can retry once the cause is fixed.
        row.payload_ciphertext,
        now.toISOString(),
        id,
      );
    }
    return toDelivery(this.db.prepare('SELECT * FROM mail_deliveries WHERE id = ?').get(id) as DeliveryRow);
  }

  /** Attempts every delivery whose retry is due. Called on a timer. */
  async retryDue(now = new Date()): Promise<number> {
    const due = this.db.prepare(
      "SELECT id FROM mail_deliveries WHERE status = 'retrying' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50",
    ).pluck().all(now.toISOString()) as string[];
    for (const id of due) await this.attempt(id);
    return due.length;
  }

  /** An admin retrying a failed delivery by hand, e.g. after fixing the credential. */
  async retry(id: string): Promise<MailDelivery | undefined> {
    const row = this.db.prepare('SELECT * FROM mail_deliveries WHERE id = ?').get(id) as DeliveryRow | undefined;
    if (!row) return undefined;
    if (row.status === 'sent' || !row.payload_ciphertext) return toDelivery(row);
    return this.attempt(id);
  }

  listDeliveries(filter: { status?: MailDelivery['status']; limit: number }): MailDelivery[] {
    const rows = (filter.status
      ? this.db.prepare('SELECT * FROM mail_deliveries WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(filter.status, filter.limit)
      : this.db.prepare('SELECT * FROM mail_deliveries ORDER BY created_at DESC, rowid DESC LIMIT ?').all(filter.limit)) as DeliveryRow[];
    return rows.map(toDelivery);
  }

}
