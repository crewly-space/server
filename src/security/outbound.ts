import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export interface ResolvedAddress { address: string; family: number }
export type PublicLookup = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultLookup: PublicLookup = (hostname) => dnsLookup(hostname, { all: true });

export function isPrivateOrReservedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (version === 6) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1' || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) ||
      value.startsWith('ff') || value.startsWith('2001:db8:')) return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateOrReservedAddress(mapped[1]!) : false;
  }
  return true;
}

/**
 * A self-hosted server may be told to reach its own network — a model server
 * on localhost or the LAN, say. Hosted servers never set this, so for them
 * every outbound call stays public HTTPS.
 */
export function privateNetworkAllowed(): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env.CREWLY_ALLOW_PRIVATE_NETWORK ?? '').toLowerCase());
}

export function parsePublicHttpsUrl(raw: string | URL): URL {
  const url = raw instanceof URL ? new URL(raw) : new URL(raw);
  if (url.username || url.password) throw new Error('outbound_url_not_allowed');
  if (privateNetworkAllowed()) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('outbound_url_not_allowed');
    return url;
  }
  if (url.protocol !== 'https:') throw new Error('outbound_url_not_allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateOrReservedAddress(host)) throw new Error('outbound_private_network_blocked');
  return url;
}

export async function resolvePublicHttpsUrl(raw: string | URL, lookup: PublicLookup = defaultLookup): Promise<{ url: URL; address: ResolvedAddress }> {
  const url = parsePublicHttpsUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  if (!addresses.length || (!privateNetworkAllowed() && addresses.some((entry) => isPrivateOrReservedAddress(entry.address)))) {
    throw new Error('outbound_private_network_blocked');
  }
  return { url, address: addresses[0]! };
}

function bodyBytes(body: BodyInit | null | undefined): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error('unsupported_outbound_request_body');
}

/** A DNS resolver that preserves the shape requested by Node's HTTP client. */
export function pinnedLookupFor(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      (callback as (error: NodeJS.ErrnoException | null, addresses: ResolvedAddress[]) => void)(null, [address]);
      return;
    }
    (callback as (error: NodeJS.ErrnoException | null, value: string, family: number) => void)(
      null, address.address, address.family,
    );
  };
}

/** Resolve once, reject every non-public answer, and pin the actual socket to that result. */
export async function fetchPublicHttps(
  raw: string | URL,
  init: RequestInit = {},
  injectedFetch?: typeof fetch,
  lookup: PublicLookup = defaultLookup,
): Promise<Response> {
  const url = parsePublicHttpsUrl(raw);
  // Test and embedding callers can inject a transport. Literal private targets
  // are still rejected; production uses the DNS-pinned native path below.
  if (injectedFetch) return injectedFetch(url.toString(), { ...init, redirect: 'error' });
  const resolved = await resolvePublicHttpsUrl(url, lookup);
  const headers = new Headers(init.headers);
  const body = bodyBytes(init.body);
  if (body && !headers.has('content-length')) headers.set('content-length', String(body.byteLength));
  const transport = resolved.url.protocol === 'https:' ? https : http;
  // Node 24 enables the multi-address connection path for HTTP clients and
  // asks custom DNS resolvers for `all` addresses. Returning the older
  // `(address, family)` shape in that case makes Node read `address.address`
  // from a string and fail with ERR_INVALID_IP_ADDRESS ("undefined"). Keep
  // the socket pinned to the one address we already vetted, in the shape the
  // caller requested.
  const pinnedLookup = pinnedLookupFor(resolved.address);
  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(resolved.url, {
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal ?? undefined,
      lookup: pinnedLookup,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 25 * 1024 * 1024) request.destroy(new Error('outbound_response_too_large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode ?? 500,
        statusText: response.statusMessage,
        headers: response.headers as HeadersInit,
      })));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}
