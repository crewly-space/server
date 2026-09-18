import type { HttpClient } from '../http-client.js';

export interface HealthStatus {
  ok: boolean;
}

export class HealthResource {
  constructor(private readonly http: HttpClient) {}

  get(): Promise<HealthStatus> {
    return this.http.request('GET', '/api/v1/health');
  }
}
