import { ApprovalRequestSchema, type ApprovalRequest, type ApprovalStatus } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';

interface ApprovalRow {
  id: string;
  run_id: string;
  agent_id: string;
  action: string;
  details: string;
  status: ApprovalStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by?: string | null;
  expires_at?: string | null;
  execution?: string | null;
}

function rowToApproval(row: ApprovalRow): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    action: row.action,
    details: JSON.parse(row.details),
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by ?? null,
    expiresAt: row.expires_at ?? null,
    execution: row.execution ? JSON.parse(row.execution) : null,
  });
}

export class ApprovalAlreadyResolvedError extends Error {}

export function createApproval(
  db: Database,
  input: {
    runId: string;
    agentId: string;
    action: string;
    details: Record<string, unknown>;
    capability?: string;
    actionHash?: string;
    expiresAt?: string;
  }
): ApprovalRequest {
  const row: ApprovalRow = {
    id: randomUUID(),
    run_id: input.runId,
    agent_id: input.agentId,
    action: input.action,
    details: JSON.stringify(input.details),
    status: 'pending',
    created_at: new Date().toISOString(),
    resolved_at: null,
  };
  db.prepare(
    `INSERT INTO approvals (id, run_id, agent_id, action, details, status, created_at, resolved_at, capability, action_hash, expires_at)
     VALUES (@id, @run_id, @agent_id, @action, @details, @status, @created_at, @resolved_at, @capability, @action_hash, @expires_at)`
  ).run({ ...row, capability: input.capability ?? null, action_hash: input.actionHash ?? null,
    expires_at: input.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000).toISOString() });
  return rowToApproval(row);
}

export function getApproval(db: Database, id: string): ApprovalRequest | undefined {
  expireApprovals(db);
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  return row ? rowToApproval(row) : undefined;
}

export function getApprovalForOwner(
  db: Database,
  id: string,
  ownerUserId: string,
): ApprovalRequest | undefined {
  const row = db.prepare(
    `SELECT approvals.* FROM approvals
     JOIN agents ON agents.id = approvals.agent_id
     WHERE approvals.id = ? AND agents.owner_user_id = ?`
  ).get(id, ownerUserId) as ApprovalRow | undefined;
  return row ? rowToApproval(row) : undefined;
}

export function listPendingApprovals(db: Database): ApprovalRequest[] {
  expireApprovals(db);
  const rows = db
    .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as ApprovalRow[];
  return rows.map(rowToApproval);
}

export function listPendingApprovalsForOwner(db: Database, ownerUserId: string): ApprovalRequest[] {
  expireApprovals(db);
  const rows = db.prepare(
    `SELECT approvals.* FROM approvals
     JOIN agents ON agents.id = approvals.agent_id
     WHERE approvals.status = 'pending' AND agents.owner_user_id = ?
     ORDER BY approvals.created_at ASC`
  ).all(ownerUserId) as ApprovalRow[];
  return rows.map(rowToApproval);
}

export function expireApprovals(db: Database, now = new Date()): number {
  return Number(db.prepare(`UPDATE approvals SET status = 'expired', resolved_at = ?
    WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`).run(now.toISOString(), now.toISOString()).changes);
}

export function resolveApproval(
  db: Database,
  id: string,
  decision: 'approve' | 'deny',
  resolvedBy: string | null = null,
): ApprovalRequest {
  const existing = getApproval(db, id);
  if (!existing) {
    throw new Error('approval_not_found');
  }
  if (existing.status !== 'pending') {
    throw new ApprovalAlreadyResolvedError(`approval ${id} already resolved with status ${existing.status}`);
  }
  const status: ApprovalStatus = decision === 'approve' ? 'approved' : 'denied';
  // Only a still-pending row moves, so two people deciding at once cannot both win.
  const changed = db.prepare("UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'").run(
    status,
    new Date().toISOString(),
    resolvedBy,
    id
  ).changes;
  if (!changed) throw new ApprovalAlreadyResolvedError(`approval ${id} was resolved concurrently`);
  return getApproval(db, id)!;
}

/** Decided approvals, newest first: who approved or denied what, and when. */
export function listResolvedApprovals(db: Database, input: { ownerUserId?: string; limit?: number } = {}): ApprovalRequest[] {
  expireApprovals(db);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = input.ownerUserId
    ? db.prepare(`SELECT approvals.* FROM approvals JOIN agents ON agents.id = approvals.agent_id
        WHERE approvals.status <> 'pending' AND agents.owner_user_id = ? ORDER BY approvals.resolved_at DESC LIMIT ${limit}`).all(input.ownerUserId)
    : db.prepare(`SELECT * FROM approvals WHERE status <> 'pending' ORDER BY resolved_at DESC LIMIT ${limit}`).all();
  return (rows as ApprovalRow[]).map(rowToApproval);
}
