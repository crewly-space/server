import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/driver.js';
import { createMessage } from '../messages/repository.js';
import type { ConnectionHub } from '../ws/hub.js';
import { runAgentTurn, type RespondFn } from '../runtime/engine.js';
import type { AgentRunQueue } from '../runtime/queue.js';

export type AutomationTriggerType = 'webhook' | 'message' | 'schedule' | 'run';
export type AutomationAction =
  | { type: 'post_message'; conversationId?: string; body: string }
  | { type: 'invoke_agent'; agentId: string; conversationId?: string; prompt?: string }
  | { type: 'call_webhook'; url: string; method?: 'POST' | 'PUT'; body?: unknown };

export interface AutomationInput {
  name: string;
  description?: string;
  enabled?: boolean;
  triggerType: AutomationTriggerType;
  triggerConfig?: Record<string, unknown>;
  conditions?: Record<string, unknown>;
  actions: AutomationAction[];
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  conditions: Record<string, unknown>;
  actions: AutomationAction[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  webhookEndpoint?: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  triggerEventId: string | null;
  dedupeKey: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  hopCount: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface AutomationRow {
  id: string; name: string; description: string; enabled: number; trigger_type: AutomationTriggerType;
  trigger_config: string; conditions: string; actions: string; created_by: string | null;
  created_at: string; updated_at: string;
}
interface RunRow {
  id: string; automation_id: string; trigger_event_id: string | null; dedupe_key: string;
  status: AutomationRun['status']; hop_count: number; input: string; output: string;
  error: string | null; created_at: string; finished_at: string | null;
}

const MAX_HOPS = 3;
const safeJson = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');

function view(row: AutomationRow): Automation {
  const triggerConfig = safeJson<Record<string, unknown>>(row.trigger_config, {});
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    triggerType: row.trigger_type,
    triggerConfig: Object.fromEntries(Object.entries(triggerConfig).filter(([key]) => key !== 'secretHash')),
    conditions: safeJson<Record<string, unknown>>(row.conditions, {}),
    actions: safeJson<AutomationAction[]>(row.actions, []),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runView(row: RunRow): AutomationRun {
  return {
    id: row.id, automationId: row.automation_id, triggerEventId: row.trigger_event_id,
    dedupeKey: row.dedupe_key, status: row.status, hopCount: row.hop_count,
    input: safeJson(row.input, {}), output: safeJson(row.output, {}), error: row.error,
    createdAt: row.created_at, finishedAt: row.finished_at,
  };
}

function prepareInput(input: AutomationInput): { data: AutomationInput; webhookSecret?: string } {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw new Error('automation_name_invalid');
  if (!input.actions.length || input.actions.length > 20) throw new Error('automation_actions_invalid');
  const config = { ...(input.triggerConfig ?? {}) };
  let webhookSecret: string | undefined;
  if (input.triggerType === 'webhook') {
    webhookSecret = randomBytes(24).toString('base64url');
    config.secretHash = hashSecret(webhookSecret);
  }
  if (input.triggerType === 'schedule') {
    const interval = Number(config.intervalMinutes ?? 60);
    if (!Number.isInteger(interval) || interval < 1 || interval > 10080) throw new Error('schedule_interval_invalid');
    config.intervalMinutes = interval;
  }
  return {
    webhookSecret,
    data: { ...input, name, description: input.description?.trim() ?? '', triggerConfig: config },
  };
}

export function listAutomations(db: Database, baseUrl?: string): Automation[] {
  return (db.prepare('SELECT * FROM automations ORDER BY name COLLATE NOCASE').all() as AutomationRow[]).map((row) => {
    const result = view(row);
    if (row.trigger_type === 'webhook' && baseUrl) result.webhookEndpoint = `${baseUrl.replace(/\/$/, '')}/api/v1/automations/${row.id}/webhook`;
    return result;
  });
}

export function getAutomation(db: Database, id: string): Automation | undefined {
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow | undefined;
  return row ? view(row) : undefined;
}

export function createAutomation(db: Database, input: AutomationInput & { createdBy: string }): { automation: Automation; webhookSecret?: string } {
  const prepared = prepareInput(input);
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`INSERT INTO automations
    (id, name, description, enabled, trigger_type, trigger_config, conditions, actions, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, prepared.data.name, prepared.data.description ?? '', prepared.data.enabled === false ? 0 : 1,
      prepared.data.triggerType, JSON.stringify(prepared.data.triggerConfig ?? {}), JSON.stringify(prepared.data.conditions ?? {}),
      JSON.stringify(prepared.data.actions), input.createdBy, now, now);
  return { automation: getAutomation(db, id)!, webhookSecret: prepared.webhookSecret };
}

export function updateAutomation(db: Database, id: string, input: AutomationInput): Automation {
  const current = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow | undefined;
  if (!current) throw new Error('automation_not_found');
  const prepared = prepareInput({ ...input, triggerConfig: input.triggerConfig ?? safeJson(current.trigger_config, {}) });
  const config = input.triggerType === current.trigger_type && input.triggerType === 'webhook'
    ? { ...(input.triggerConfig ?? safeJson<Record<string, unknown>>(current.trigger_config, {})), secretHash: safeJson<Record<string, unknown>>(current.trigger_config, {}).secretHash }
    : prepared.data.triggerConfig;
  db.prepare(`UPDATE automations SET name = ?, description = ?, enabled = ?, trigger_type = ?, trigger_config = ?, conditions = ?, actions = ?, updated_at = ? WHERE id = ?`)
    .run(prepared.data.name, prepared.data.description ?? '', prepared.data.enabled === false ? 0 : 1, prepared.data.triggerType,
      JSON.stringify(config), JSON.stringify(prepared.data.conditions ?? {}), JSON.stringify(prepared.data.actions), new Date().toISOString(), id);
  return getAutomation(db, id)!;
}

export function deleteAutomation(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0;
}

export function verifyWebhookSecret(db: Database, id: string, secret: string): boolean {
  const row = db.prepare('SELECT trigger_config FROM automations WHERE id = ? AND trigger_type = \'webhook\' AND enabled = 1').get(id) as { trigger_config: string } | undefined;
  const expected = typeof safeJson<Record<string, unknown>>(row?.trigger_config ?? '{}', {}).secretHash === 'string'
    ? String(safeJson<Record<string, unknown>>(row?.trigger_config ?? '{}', {}).secretHash) : '';
  const received = Buffer.from(hashSecret(secret));
  const stored = Buffer.from(expected);
  return Boolean(expected) && received.length === stored.length && timingSafeEqual(received, stored);
}

export interface AutomationEvent {
  type: AutomationTriggerType;
  eventId?: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  conversationId?: string;
  hopCount?: number;
}

export interface AutomationDeps {
  db: Database;
  hub: ConnectionHub;
  respond: RespondFn;
  queue?: AgentRunQueue;
  fetchImpl?: typeof fetch;
  automationDispatch?: (event: { type: 'message' | 'run'; eventId: string; dedupeKey: string; payload: Record<string, unknown>; conversationId?: string; hopCount?: number }) => Promise<void> | void;
}

function conditionsMatch(conditions: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  return Object.entries(conditions).every(([key, expected]) => {
    const actual = payload[key];
    if (Array.isArray(expected)) return expected.includes(actual);
    if (typeof expected === 'string' && typeof actual === 'string') return actual.toLowerCase().includes(expected.toLowerCase());
    return actual === expected;
  });
}

function beginRun(db: Database, rule: Automation, event: AutomationEvent): AutomationRun | undefined {
  const now = new Date().toISOString();
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO automation_runs
      (id, automation_id, trigger_event_id, dedupe_key, status, hop_count, input, created_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`)
      .run(id, rule.id, event.eventId ?? null, event.dedupeKey, event.hopCount ?? 0, JSON.stringify(event.payload), now);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE')) return undefined;
    throw error;
  }
  return runView(db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as RunRow);
}

async function executeActions(deps: AutomationDeps, rule: Automation, event: AutomationEvent): Promise<Record<string, unknown>> {
  const outputs: unknown[] = [];
  for (const action of rule.actions) {
    if (action.type === 'post_message') {
      const conversationId = action.conversationId ?? event.conversationId;
      if (!conversationId) throw new Error('automation_message_conversation_required');
      const message = createMessage(deps.db, { conversationId, authorId: `automation:${rule.id}`, authorType: 'integration', body: action.body, mentions: [], replyToMessageId: null });
      deps.hub.publish(`conversation:${conversationId}`, 'message.created', { ...message });
      outputs.push({ type: action.type, messageId: message.id });
      continue;
    }
    if (action.type === 'invoke_agent') {
      const conversationId = action.conversationId ?? event.conversationId;
      if (!conversationId) throw new Error('automation_agent_conversation_required');
      const prompt = action.prompt?.trim() || `Automation ${rule.name} was triggered.`;
      const promptMessage = createMessage(deps.db, { conversationId, authorId: `automation:${rule.id}`, authorType: 'integration', body: prompt, mentions: [], replyToMessageId: null });
      deps.hub.publish(`conversation:${conversationId}`, 'message.created', { ...promptMessage });
      const result = await runAgentTurn(deps, { agentId: action.agentId, conversationId, trigger: 'automation', triggerMessageId: promptMessage.id, hopCount: (event.hopCount ?? 0) + 1 });
      outputs.push({ type: action.type, runId: result.run.runId, messageId: result.message.id });
      continue;
    }
    const url = new URL(action.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('automation_webhook_url_invalid');
    const response = await (deps.fetchImpl ?? globalThis.fetch)(url, {
      method: action.method ?? 'POST',
      headers: { 'content-type': 'application/json', 'x-crewly-automation': rule.id },
      body: JSON.stringify(action.body ?? event.payload),
    });
    if (!response.ok) throw new Error(`automation_webhook_failed_${response.status}`);
    outputs.push({ type: action.type, status: response.status });
  }
  return { actions: outputs };
}

export async function dispatchAutomationEvent(deps: AutomationDeps, event: AutomationEvent): Promise<void> {
  const hopCount = event.hopCount ?? 0;
  const rules = (deps.db.prepare('SELECT * FROM automations WHERE enabled = 1 AND trigger_type = ?').all(event.type) as AutomationRow[]).map(view);
  if (hopCount > MAX_HOPS) return;
  for (const rule of rules) {
    if (!conditionsMatch(rule.conditions, event.payload)) continue;
    const run = beginRun(deps.db, rule, event);
    if (!run) continue;
    try {
      const output = await executeActions(deps, rule, event);
      deps.db.prepare('UPDATE automation_runs SET status = \'succeeded\', output = ?, finished_at = ? WHERE id = ?').run(JSON.stringify(output), new Date().toISOString(), run.id);
    } catch (error) {
      deps.db.prepare('UPDATE automation_runs SET status = \'failed\', error = ?, finished_at = ? WHERE id = ?')
        .run(error instanceof Error ? error.message : String(error), new Date().toISOString(), run.id);
    }
  }
}

export async function runDueSchedules(deps: AutomationDeps, now = new Date()): Promise<void> {
  const rules = (deps.db.prepare("SELECT * FROM automations WHERE enabled = 1 AND trigger_type = 'schedule'").all() as AutomationRow[]).map(view);
  for (const rule of rules) {
    const interval = Number(rule.triggerConfig.intervalMinutes ?? 60);
    const slot = Math.floor(now.getTime() / (interval * 60_000));
    await dispatchAutomationEvent(deps, {
      type: 'schedule', eventId: `schedule:${rule.id}:${slot}`, dedupeKey: `schedule:${slot}`,
      payload: { scheduledAt: now.toISOString(), slot }, hopCount: 0,
    });
  }
}

export function listAutomationRuns(db: Database, automationId?: string, limit = 100): AutomationRun[] {
  const rows = (automationId
    ? db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?').all(automationId, limit)
    : db.prepare('SELECT * FROM automation_runs ORDER BY created_at DESC LIMIT ?').all(limit)) as RunRow[];
  return rows.map(runView);
}
