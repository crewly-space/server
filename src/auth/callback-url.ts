import type { FastifyRequest } from 'fastify';

export function allowedCallbackUrl(request: FastifyRequest, raw: string, configuredOrigins: readonly string[]): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return false;
    const origins = new Set(configuredOrigins.map((origin) => new URL(origin).origin));
    origins.add(`${request.protocol}://${request.headers.host ?? request.hostname}`);
    if (request.headers.origin) origins.add(request.headers.origin);
    return origins.has(url.origin);
  } catch {
    return false;
  }
}
