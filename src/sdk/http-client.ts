import { CrewlyApiError } from './errors.js';

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
        `network error calling ${method} ${path}: ${(err as Error).message}`,
        0,
        'network_error'
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
      const code =
        data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
          ? String((data as Record<string, unknown>).error)
          : undefined;
      throw new CrewlyApiError(`request failed with status ${response.status}`, response.status, code, data);
    }

    return data as T;
  }
}
