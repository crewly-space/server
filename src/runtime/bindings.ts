import { RuntimeBindingSchema, type RuntimeBinding, type RuntimeKind } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { randomUUID } from 'node:crypto';

interface RuntimeBindingRow {
  id: string;
  agent_id: string;
  runtime_kind: RuntimeKind;
  workspace_path: string;
  vendor_state: string;
  created_at: string;
  updated_at: string;
}

function rowToRuntimeBinding(row: RuntimeBindingRow): RuntimeBinding {
  return RuntimeBindingSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    runtimeKind: row.runtime_kind,
    workspacePath: row.workspace_path,
    vendorState: JSON.parse(row.vendor_state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createRuntimeBinding(
  db: Database,
  input: { agentId: string; runtimeKind: RuntimeKind; workspacePath: string; vendorState?: Record<string, unknown> }
): RuntimeBinding {
  const now = new Date().toISOString();
  const row: RuntimeBindingRow = {
    id: randomUUID(),
    agent_id: input.agentId,
    runtime_kind: input.runtimeKind,
    workspace_path: input.workspacePath,
    vendor_state: JSON.stringify(input.vendorState ?? {}),
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO runtime_bindings (id, agent_id, runtime_kind, workspace_path, vendor_state, created_at, updated_at)
     VALUES (@id, @agent_id, @runtime_kind, @workspace_path, @vendor_state, @created_at, @updated_at)`
  ).run(row);
  return rowToRuntimeBinding(row);
}

export function getRuntimeBinding(db: Database, id: string): RuntimeBinding | undefined {
  const row = db.prepare('SELECT * FROM runtime_bindings WHERE id = ?').get(id) as RuntimeBindingRow | undefined;
  return row ? rowToRuntimeBinding(row) : undefined;
}

export function listRuntimeBindingsForAgent(db: Database, agentId: string): RuntimeBinding[] {
  const rows = db.prepare('SELECT * FROM runtime_bindings WHERE agent_id = ?').all(agentId) as RuntimeBindingRow[];
  return rows.map(rowToRuntimeBinding);
}
