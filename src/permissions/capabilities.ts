import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { createApproval } from '../approvals/repository.js';

export const EXECUTION_CAPABILITIES = [
  'filesystem.read',
  'filesystem.write',
  'process.execute',
  'network.access',
  'secret.read',
  'external.side_effect',
  'browser.control',
] as const;

export type ExecutionCapability = typeof EXECUTION_CAPABILITIES[number];
export type CapabilityDecision = 'allow' | 'ask' | 'deny';
export type CapabilityScope = Record<string, string | string[]>;

export interface CapabilityPolicy {
  id: string;
  agentId: string | null;
  capability: ExecutionCapability;
  decision: CapabilityDecision;
  scope: CapabilityScope;
  createdAt: string;
  updatedAt: string;
}

interface PolicyRow {
  id: string;
  agent_id: string | null;
  capability: ExecutionCapability;
  decision: CapabilityDecision;
  scope: string;
  created_at: string;
  updated_at: string;
}

const DEFAULTS: Record<ExecutionCapability, CapabilityDecision> = {
  'filesystem.read': 'ask',
  'filesystem.write': 'ask',
  'process.execute': 'ask',
  'network.access': 'ask',
  'secret.read': 'ask',
  'external.side_effect': 'ask',
  'browser.control': 'deny',
};

function view(row: PolicyRow): CapabilityPolicy {
  return {
    id: row.id,
    agentId: row.agent_id,
    capability: row.capability,
    decision: row.decision,
    scope: JSON.parse(row.scope) as CapabilityScope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function matchesScope(policy: CapabilityScope, target: CapabilityScope): boolean {
  return Object.entries(policy).every(([key, expected]) => {
    const actual = target[key];
    if (Array.isArray(expected)) {
      const values = Array.isArray(actual) ? actual : actual === undefined ? [] : [actual];
      return expected.some((entry) => values.includes(entry));
    }
    if (Array.isArray(actual)) return actual.includes(expected);
    if (key === 'domain' && typeof actual === 'string') {
      return actual === expected || (expected.startsWith('*.') && actual.endsWith(expected.slice(1)));
    }
    if (key === 'path' && typeof actual === 'string') return actual === expected || actual.startsWith(`${expected}/`);
    return actual === expected;
  });
}

export function listCapabilityPolicies(db: Database, agentId?: string): CapabilityPolicy[] {
  const rows = agentId
    ? db.prepare('SELECT * FROM capability_policies WHERE agent_id IS NULL OR agent_id = ? ORDER BY agent_id IS NULL, capability, created_at').all(agentId)
    : db.prepare('SELECT * FROM capability_policies ORDER BY agent_id IS NOT NULL, capability, created_at').all();
  return (rows as PolicyRow[]).map(view);
}

export function replaceCapabilityPolicies(
  db: Database,
  agentId: string | null,
  policies: Array<{ capability: ExecutionCapability; decision: CapabilityDecision; scope?: CapabilityScope }>,
  createdBy: string,
): CapabilityPolicy[] {
  const now = new Date().toISOString();
  db.transaction(() => {
    if (agentId) db.prepare('DELETE FROM capability_policies WHERE agent_id = ?').run(agentId);
    else db.prepare('DELETE FROM capability_policies WHERE agent_id IS NULL').run();
    for (const policy of policies) {
      db.prepare(`INSERT INTO capability_policies
        (id, agent_id, capability, decision, scope, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), agentId, policy.capability, policy.decision, JSON.stringify(policy.scope ?? {}), createdBy, now, now);
    }
  })();
  return listCapabilityPolicies(db, agentId ?? undefined).filter((policy) => policy.agentId === agentId);
}

export function evaluateCapability(
  db: Database,
  input: { agentId: string; capability: ExecutionCapability; scope?: CapabilityScope },
): { decision: CapabilityDecision; policyId: string | null } {
  const policies = listCapabilityPolicies(db, input.agentId)
    .filter((policy) => policy.capability === input.capability && matchesScope(policy.scope, input.scope ?? {}))
    .sort((a, b) => {
      const agentSpecific = Number(Boolean(b.agentId)) - Number(Boolean(a.agentId));
      if (agentSpecific) return agentSpecific;
      return Object.keys(b.scope).length - Object.keys(a.scope).length;
    });
  const winner = policies[0];
  return winner ? { decision: winner.decision, policyId: winner.id } : { decision: DEFAULTS[input.capability], policyId: null };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Exact, payload-safe identity for an approval. Traces store this digest, not contents. */
export function capabilityActionHash(input: { capability: ExecutionCapability; action: string; scope?: CapabilityScope; target?: unknown }): string {
  return createHash('sha256').update(stable(input)).digest('hex');
}

export function recordPolicyDecision(
  db: Database,
  input: { runId: string; capability: ExecutionCapability; decision: CapabilityDecision; policyId: string | null; actionHash: string },
): void {
  const seq = Number(db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE run_id = ?').pluck().get(input.runId));
  db.prepare('INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.runId, seq, 'policy.decision', JSON.stringify({
      capability: input.capability,
      decision: input.decision,
      policyId: input.policyId,
      actionHash: input.actionHash,
    }), new Date().toISOString());
}

/** Applies one capability rule to one exact action and queues a short-lived approval when needed. */
export function authorizeCapabilityAction(
  db: Database,
  input: { agentId: string; runId: string; capability: ExecutionCapability; action: string; scope?: CapabilityScope; target?: unknown },
): { allowed: boolean; reason?: 'denied' | 'approval_required'; actionHash: string } {
  const scope = input.scope ?? {};
  const actionHash = capabilityActionHash({ capability: input.capability, action: input.action, scope, target: input.target });
  const result = evaluateCapability(db, { agentId: input.agentId, capability: input.capability, scope });
  recordPolicyDecision(db, { runId: input.runId, capability: input.capability, decision: result.decision, policyId: result.policyId, actionHash });
  if (result.decision === 'deny') return { allowed: false, reason: 'denied', actionHash };
  if (result.decision === 'allow') return { allowed: true, actionHash };
  const existing = db.prepare('SELECT status FROM approvals WHERE run_id = ? AND action_hash = ? ORDER BY created_at DESC LIMIT 1')
    .pluck().get(input.runId, actionHash) as string | undefined;
  if (existing === 'approved') return { allowed: true, actionHash };
  if (!existing || existing === 'denied' || existing === 'expired') {
    createApproval(db, { runId: input.runId, agentId: input.agentId, action: input.action, capability: input.capability, actionHash,
      details: { capability: input.capability, scope }, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
  }
  return { allowed: false, reason: 'approval_required', actionHash };
}
