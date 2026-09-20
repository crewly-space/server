import { CrewlyApiError, describeStatus } from './errors.js';

export class HttpClient {
  private token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl?: typeof fetch) {
    this.baseUrl = baseUrl;
    // fetch must stay bound to its realm. A bare reference stored on the instance
    // and called as this.fetchImpl(...) throws "Illegal invocation" in browsers.
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new CrewlyApiError(
        describeStatus(0, 'network_error'),
        0,
        'network_error',
        { detail: `${method} ${path}: ${(err as Error).message}` }
      );
    }

    let text: string | undefined;
    let data: unknown;
    try {
      text = await response.text();
      data = text.length > 0 ? JSON.parse(text) : undefined;
    } catch (err) {
      throw new CrewlyApiError(
        `invalid response calling ${method} ${path}: ${(err as Error).message}`,
        response.status,
        'invalid_response',
        text
      );
    }

    if (!response.ok) {
      const payload = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
      const code = payload && 'error' in payload ? String(payload.error) : undefined;
      // The server explains failures in `message` and names them in `error`.
      // Callers show `error.message`, so carry the explanation rather than the
      // status line — "request failed with status 409" tells a person nothing.
      const explained =
        payload && typeof payload.message === 'string' && payload.message.length > 0
          ? payload.message
          : undefined;
      throw new CrewlyApiError(
        explained ?? describeStatus(response.status, code),
        response.status,
        code,
        data
      );
    }

    return data as T;
  }
}
