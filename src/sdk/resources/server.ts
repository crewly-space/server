import type { HttpClient } from '../http-client.js';

/** How much of everything one server holds, for whoever runs it. */
export interface ServerStatus {
  version: string;
  uptimeSeconds: number;
  usage: {
    users: number;
    agents: number;
    conversations: number;
    messages: number;
    providers: number;
    devices: number;
  };
  jobs: { pending: number; failed: number };
  approvals: { pending: number };
}

export interface ServerLogEntry {
  kind: 'job_failed' | 'agent_run_failed';
  at: string;
  subject: string;
  detail: string;
}

export class ServerResource {
  constructor(private readonly http: HttpClient) {}

  status(): Promise<ServerStatus> {
    return this.http.request('GET', '/api/v1/server/status');
  }

  /** Recent failures somebody administering the server can act on. */
  logs(limit = 50): Promise<{ entries: ServerLogEntry[] }> {
    return this.http.request('GET', `/api/v1/server/logs?limit=${limit}`);
  }
}
