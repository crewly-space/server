import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export type MailProvider = 'disabled' | 'crewly' | 'smtp' | 'resend' | 'postmark';
export type MailErrorClass = 'network' | 'rate_limited' | 'provider_unavailable' | 'auth' | 'rejected' | 'not_permitted' | 'config';

/** Mail settings as the API shows them: never the password or API key. */
export interface MailSettings {
  provider: MailProvider;
  fromAddress: string | null;
  config: { host?: string; port?: number; security?: 'tls' | 'starttls' | 'none'; username?: string };
  hasSecret: boolean;
  updatedAt: string | null;
}

export interface MailSettingsInput {
  provider: MailProvider;
  fromAddress?: string | null;
  config?: MailSettings['config'];
  /** Replaces the stored password or API key; omit to keep it. */
  secret?: string;
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

export interface MailSender {
  localPart: string;
  name?: string | null;
}

/** A sending domain for Crewly Mail, with the DNS records its provider asked for. */
export interface MailDomain {
  id: string;
  domain: string;
  status: 'pending' | 'verified' | 'failed';
  /** Why it is not verified yet, in words to act on. */
  failureReason: string | null;
  records: Array<{ type: string; name: string; value: string; priority?: number; purpose: string }>;
  senders: MailSender[];
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/** An email Crewly Mail delivered to this server, and what became of it. */
export interface InboundMail {
  id: string;
  kind: 'reply' | 'route';
  sender: string;
  recipient: string;
  status: 'delivered' | 'rejected';
  /** Why it was not posted, e.g. `sender_mismatch`. */
  reason: string | null;
  conversationId: string | null;
  messageId: string | null;
  receivedAt: string;
  processedAt: string;
}

/** An address on a verified domain whose mail is posted into a conversation. */
export interface InboundRoute {
  address: string;
  conversationId: string;
  postedBy: string;
  createdAt: string;
}

export interface MailOverview {
  settings: MailSettings;
  providers: MailProvider[];
  /** Whether this server is connected to Crewly with `mail:send`. */
  crewlyMailAvailable: boolean;
  retryPolicy: { maxAttempts: number; delaysMs: number[] };
}

/** Outbound email: provider, test-send and the delivery log. Owners and admins only. */
export class MailResource {
  constructor(private readonly http: HttpClient) {}

  get(): Promise<MailOverview> {
    return this.http.request('GET', '/api/v1/server/mail');
  }

  update(input: MailSettingsInput): Promise<{ settings: MailSettings }> {
    return this.http.request('PUT', '/api/v1/server/mail', input);
  }

  test(to: string): Promise<{ delivery: MailDelivery }> {
    return this.http.request('POST', '/api/v1/server/mail/test', { to });
  }

  deliveries(filter: { status?: MailDelivery['status']; limit?: number } = {}): Promise<{ deliveries: MailDelivery[] }> {
    const query = new URLSearchParams();
    if (filter.status) query.set('status', filter.status);
    if (filter.limit) query.set('limit', String(filter.limit));
    const suffix = query.size ? `?${query}` : '';
    return this.http.request('GET', `/api/v1/server/mail/deliveries${suffix}`);
  }

  retry(id: string): Promise<{ delivery: MailDelivery }> {
    return this.http.request('POST', `/api/v1/server/mail/deliveries/${encodePathSegment(id)}/retry`);
  }

  /** Custom sending domains for Crewly Mail, verified in Crewly. Needs the Crewly connection with `mail:send`. */
  domains(): Promise<{ domains: MailDomain[] }> {
    return this.http.request('GET', '/api/v1/server/mail/domains');
  }

  /** Returns the DNS records to add; the domain is used once `check` reports it verified. */
  addDomain(domain: string): Promise<{ domain: MailDomain }> {
    return this.http.request('POST', '/api/v1/server/mail/domains', { domain });
  }

  checkDomain(id: string): Promise<{ domain: MailDomain }> {
    return this.http.request('POST', `/api/v1/server/mail/domains/${encodePathSegment(id)}/check`);
  }

  /** The addresses on the domain this server may send from; the first is the default. */
  setDomainSenders(id: string, senders: MailSender[]): Promise<{ domain: MailDomain }> {
    return this.http.request('PUT', `/api/v1/server/mail/domains/${encodePathSegment(id)}/senders`, { senders });
  }

  removeDomain(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/server/mail/domains/${encodePathSegment(id)}`);
  }

  /** Email received through Crewly Mail (`mail:receive`), newest first. */
  inbound(limit = 100): Promise<{ messages: InboundMail[] }> {
    return this.http.request('GET', `/api/v1/server/mail/inbound?limit=${limit}`);
  }

  /** What Crewly refused before it reached this server, and why. Never contents. */
  inboundRejections(): Promise<{ rejections: Array<{ id: string; recipient: string; reason: string; receivedAt: string }> }> {
    return this.http.request('GET', '/api/v1/server/mail/inbound/rejections');
  }

  inboundRoutes(): Promise<{ routes: InboundRoute[] }> {
    return this.http.request('GET', '/api/v1/server/mail/inbound/routes');
  }

  /** Posts mail to `address` (on a verified sending domain) into a conversation, as you. */
  addInboundRoute(address: string, conversationId: string): Promise<{ route: InboundRoute }> {
    return this.http.request('POST', '/api/v1/server/mail/inbound/routes', { address, conversationId });
  }

  removeInboundRoute(address: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/server/mail/inbound/routes/${encodePathSegment(address)}`);
  }

  /** What Crewly Mail has counted for this server this month, when it uses Crewly Mail. */
  usage(): Promise<{ available: false } | { available: true; periodStart: string; sent: number; failed: number }> {
    return this.http.request('GET', '/api/v1/server/mail/usage');
  }
}
