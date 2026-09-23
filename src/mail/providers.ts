import type { Database } from '../db/driver.js';
import { crewlyServiceCredential } from '../crewly/connection.js';
import { buildMimeMessage, envelopeAddress, sendSmtp, SmtpError, type SmtpConfig } from './smtp.js';
import type { MailTemplateId, RenderedMail } from './templates.js';

/*
 * One shape for every provider's answer, so the service decides retries from
 * the error class and never from a vendor's status codes.
 */

export const MAIL_PROVIDERS = ['disabled', 'crewly', 'smtp', 'resend', 'postmark'] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

export type MailErrorClass =
  /** Could not reach the provider. Retried. */
  | 'network'
  /** The provider asked us to slow down. Retried. */
  | 'rate_limited'
  /** The provider is failing on its side. Retried. */
  | 'provider_unavailable'
  /** The credential was refused. Not retried: an admin has to fix it. */
  | 'auth'
  /** The message or recipient was refused. Not retried: it would be refused again. */
  | 'rejected'
  /** Crewly Mail without the connection or `mail:send`. Not retried. */
  | 'not_permitted'
  /** Settings are incomplete. Not retried. */
  | 'config';

export const RETRYABLE: ReadonlySet<MailErrorClass> = new Set(['network', 'rate_limited', 'provider_unavailable']);

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; errorClass: MailErrorClass; message: string };

export interface OutgoingMail {
  deliveryId: string;
  from: string | null;
  to: string;
  rendered: RenderedMail;
  /** Present for system mail; Crewly Mail renders it on its side. */
  template?: { id: MailTemplateId; variables: Record<string, string> };
  headers?: Record<string, string>;
}

export interface MailTransport {
  send(mail: OutgoingMail): Promise<SendResult>;
}

const failure = (errorClass: MailErrorClass, message: string): SendResult => ({ ok: false, errorClass, message });

/** HTTP status to error class, the same for every HTTP provider. */
function classifyStatus(status: number): MailErrorClass {
  if (status === 401) return 'auth';
  if (status === 403) return 'not_permitted';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'rejected';
}

async function post(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> } | SendResult> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  } catch (error) {
    return failure('network', error instanceof Error ? error.message : 'the provider could not be reached');
  }
}

const isResult = (value: unknown): value is SendResult => typeof value === 'object' && value !== null && 'ok' in value;

const describe = (body: Record<string, unknown>, fallback: string) =>
  String(body.message ?? body.Message ?? body.error ?? fallback).slice(0, 300);

/** Crewly-managed delivery, through this server's Crewly connection and its `mail:send` capability. */
export function crewlyTransport(db: Database, fetchImpl: typeof fetch): MailTransport {
  return {
    async send(mail) {
      const connection = crewlyServiceCredential(db, 'mail:send');
      if (!connection) return failure('not_permitted', 'Crewly Mail needs this server connected to Crewly with mail:send');
      const answer = await post(
        fetchImpl,
        new URL('/api/v1/instance/mail', connection.cloudUrl).toString(),
        { authorization: `Bearer ${connection.credential}`, 'idempotency-key': mail.deliveryId },
        {
          to: mail.to,
          ...(mail.template
            ? { template: mail.template }
            : { content: { subject: mail.rendered.subject, text: mail.rendered.text, html: mail.rendered.html } }),
          ...(mail.headers ? { headers: mail.headers } : {}),
        },
      );
      if (isResult(answer)) return answer;
      if (answer.status === 200 || answer.status === 201) return { ok: true, providerMessageId: String(answer.body.id ?? '') || null };
      return failure(classifyStatus(answer.status), describe(answer.body, `Crewly Mail answered ${answer.status}`));
    },
  };
}

export function resendTransport(apiKey: string, fetchImpl: typeof fetch): MailTransport {
  return {
    async send(mail) {
      if (!mail.from) return failure('config', 'Resend needs a from address');
      const answer = await post(fetchImpl, 'https://api.resend.com/emails', { authorization: `Bearer ${apiKey}` }, {
        from: mail.from,
        to: [mail.to],
        subject: mail.rendered.subject,
        text: mail.rendered.text,
        html: mail.rendered.html,
        ...(mail.headers ? { headers: mail.headers } : {}),
      });
      if (isResult(answer)) return answer;
      if (answer.status === 200) return { ok: true, providerMessageId: String(answer.body.id ?? '') || null };
      return failure(classifyStatus(answer.status), describe(answer.body, `Resend answered ${answer.status}`));
    },
  };
}

export function postmarkTransport(serverToken: string, fetchImpl: typeof fetch): MailTransport {
  return {
    async send(mail) {
      if (!mail.from) return failure('config', 'Postmark needs a from address');
      const answer = await post(fetchImpl, 'https://api.postmarkapp.com/email', { 'x-postmark-server-token': serverToken }, {
        From: mail.from,
        To: mail.to,
        Subject: mail.rendered.subject,
        TextBody: mail.rendered.text,
        HtmlBody: mail.rendered.html,
        MessageStream: 'outbound',
        ...(mail.headers ? { Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
      });
      if (isResult(answer)) return answer;
      if (answer.status === 200 && Number(answer.body.ErrorCode ?? 0) === 0) {
        return { ok: true, providerMessageId: String(answer.body.MessageID ?? '') || null };
      }
      return failure(classifyStatus(answer.status === 200 ? 422 : answer.status), describe(answer.body, `Postmark answered ${answer.status}`));
    },
  };
}

export function smtpTransport(config: SmtpConfig, send: typeof sendSmtp = sendSmtp): MailTransport {
  return {
    async send(mail) {
      if (!mail.from) return failure('config', 'SMTP needs a from address');
      const domain = envelopeAddress(mail.from).split('@')[1] ?? 'crewly.local';
      const data = buildMimeMessage({
        from: mail.from,
        to: mail.to,
        mail: mail.rendered,
        messageId: `<${mail.deliveryId}@${domain}>`,
        headers: mail.headers,
      });
      try {
        await send(config, { from: envelopeAddress(mail.from), to: mail.to }, data);
        return { ok: true, providerMessageId: `<${mail.deliveryId}@${domain}>` };
      } catch (error) {
        if (error instanceof SmtpError) {
          if (error.code === 535 || error.code === 530 || error.code === 504) return failure('auth', error.message);
          if (error.code === 421 || error.code === 450 || error.code === 451 || error.code === 452) return failure('provider_unavailable', error.message);
          return failure('rejected', error.message);
        }
        return failure('network', error instanceof Error ? error.message : 'the SMTP server could not be reached');
      }
    },
  };
}
