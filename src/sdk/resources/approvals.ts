import type { ApprovalRequest } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export class ApprovalsResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<ApprovalRequest[]> {
    return this.http.request('GET', '/api/v1/approvals');
  }

  respond(id: string, decision: 'approve' | 'deny'): Promise<ApprovalRequest> {
    return this.http.request('POST', `/api/v1/approvals/${encodePathSegment(id)}/respond`, { decision });
  }
}
