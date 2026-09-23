import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { RenderedMail } from './templates.js';

/*
 * Just enough SMTP to hand a message to a relay: EHLO, STARTTLS or implicit
 * TLS, AUTH PLAIN, one envelope, DATA. A dependency would do more, but a
 * self-hosted server should not need one to send an invite.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** `tls`: TLS from the first byte (465). `starttls`: upgrade after EHLO (587). `none`: local relays only. */
  security: 'tls' | 'starttls' | 'none';
  username?: string;
  password?: string;
}

/** An SMTP reply that was not the one expected, with its code so it can be classified. */
export class SmtpError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

type Socket = net.Socket | tls.TLSSocket;

class Session {
  private buffer = '';
  private pending: string[] = [];
  private waiting: { resolve: (reply: { code: number; text: string }) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(public socket: Socket) {
    this.attach(socket);
  }

  attach(socket: Socket): void {
    this.socket = socket;
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        this.pending.push(this.buffer.slice(0, index).replace(/\r$/, ''));
        this.buffer = this.buffer.slice(index + 1);
      }
      this.deliver();
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('the SMTP server closed the connection')));
  }

  detach(): void {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.waiting?.reject(this.failure);
    this.waiting = null;
  }

  /** A reply ends at the line whose code is followed by a space rather than a dash. */
  private deliver(): void {
    if (!this.waiting) return;
    const end = this.pending.findIndex((line) => /^\d{3}(?: |$)/.test(line));
    if (end === -1) return;
    const lines = this.pending.splice(0, end + 1);
    const waiting = this.waiting;
    this.waiting = null;
    waiting.resolve({ code: Number(lines[end]!.slice(0, 3)), text: lines.map((line) => line.slice(4)).join('\n') });
  }

  read(): Promise<{ code: number; text: string }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.deliver();
    });
  }

  /** Sends `line` (if any) and waits for one of `codes`. Errors name only the verb, never the payload. */
  async expect(codes: number[], line?: string, label = line?.split(' ')[0] ?? 'greeting'): Promise<{ code: number; text: string }> {
    if (line !== undefined) this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    if (!codes.includes(reply.code)) throw new SmtpError(reply.code, `${label}: ${reply.code} ${reply.text}`);
    return reply;
  }
}

const headerValue = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2047 for anything that is not plain ASCII, so a subject with an accent survives. */
const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

const base64Lines = (value: string) => Buffer.from(value, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');

/** The bare address inside `Name <address>`, for the envelope. */
export function envelopeAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1]! : value).trim();
}

export function buildMimeMessage(input: { from: string; to: string; mail: RenderedMail; messageId: string; headers?: Record<string, string> }): string {
  const boundary = `crewly-${randomUUID()}`;
  const extra = Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${headerValue(value)}`);
  return [
    `From: ${headerValue(input.from)}`,
    `To: ${headerValue(input.to)}`,
    `Subject: ${encodeHeader(headerValue(input.mail.subject))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${input.messageId}`,
    ...extra,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.mail.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function open(config: SmtpConfig): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = config.security === 'tls'
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port });
    socket.setTimeout(30_000, () => socket.destroy(new Error('the SMTP server timed out')));
    socket.once(config.security === 'tls' ? 'secureConnect' : 'connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Sends one message. Resolves with the server's acceptance line, which usually names its queue id. */
export async function sendSmtp(config: SmtpConfig, envelope: { from: string; to: string }, data: string): Promise<string> {
  const socket = await open(config);
  const session = new Session(socket);
  try {
    await session.expect([220]);
    let ehlo = await session.expect([250], 'EHLO crewly');
    if (config.security === 'starttls') {
      await session.expect([220], 'STARTTLS');
      session.detach();
      const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const upgraded = tls.connect({ socket: session.socket, servername: config.host }, () => resolve(upgraded));
        upgraded.once('error', reject);
      });
      session.attach(secured);
      ehlo = await session.expect([250], 'EHLO crewly');
    }
    if (config.username) {
      if (!/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) throw new SmtpError(504, 'the SMTP server does not offer AUTH PLAIN');
      const token = Buffer.from(`\u0000${config.username}\u0000${config.password ?? ''}`, 'utf8').toString('base64');
      await session.expect([235], `AUTH PLAIN ${token}`);
    }
    await session.expect([250], `MAIL FROM:<${envelope.from}>`);
    await session.expect([250, 251], `RCPT TO:<${envelope.to}>`);
    await session.expect([354], 'DATA');
    // Dot-stuffing: a line that starts with a dot would otherwise end the message early.
    const stuffed = data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const accepted = await session.expect([250], `${stuffed.endsWith('\r\n') ? stuffed : `${stuffed}\r\n`}.`, 'message');
    session.socket.write('QUIT\r\n');
    return accepted.text;
  } finally {
    session.detach();
    // Whatever the socket says while closing is no longer anybody's problem.
    session.socket.on('error', () => {});
    session.socket.end();
  }
}
