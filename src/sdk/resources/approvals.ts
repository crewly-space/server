import type { ApprovalRequest } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export class ApprovalsResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<ApprovalRequest[]> {
    return this.http.request('GET', '/api/v1/approvals');
  }

  /**
   * Approves or denies. Approving a tool call runs it; `remember` also lets
   * this agent use that tool without asking from now on.
   */
  respond(id: string, decision: 'approve' | 'deny', options: { remember?: boolean } = {}): Promise<ApprovalRequest> {
    return this.http.request('POST', `/api/v1/approvals/${encodePathSegment(id)}/respond`, { decision, ...options });
  }

  /** Decided approvals, newest first. */
  history(limit?: number): Promise<ApprovalRequest[]> {
    return this.http.request('GET', `/api/v1/approvals/history${limit ? `?limit=${limit}` : ''}`);
  }
}
