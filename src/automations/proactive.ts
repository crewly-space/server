import { getAgent } from '../agents/repository.js';
import { getProviderConfig } from '../providers/repository.js';
import { runAgentTurn, RunCancelledError } from '../runtime/engine.js';
import type { Automation, AutomationDeps } from './service.js';

/** Daytime in the owner's chosen zone, including after daylight-saving changes. */
export function isFollowupDaytime(timeZone: string, now: Date): boolean {
  try {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
    return hour >= 8 && hour < 20;
  } catch { return false; }
}

export async function executeFollowup(deps: AutomationDeps, rule: Automation, checkAccess: () => void): Promise<Record<string, unknown>> {
  if (rule.triggerConfig.kind !== 'conversation_schedule') return { skipped: 'invalid_followup' };
  const conversationId = String(rule.triggerConfig.conversationId);
  const agentId = String(rule.triggerConfig.agentId);
  const now = Date.now();
  const latest = () => deps.db.prepare('SELECT id, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(conversationId) as { id: string; created_at: string } | undefined;
  const human = deps.db.prepare("SELECT id, created_at FROM messages WHERE conversation_id = ? AND author_type = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(conversationId) as { id: string; created_at: string } | undefined;
  const tail = latest();
  if (!human || !tail || now - Date.parse(human.created_at) > 7 * 86400000) return { skipped: 'no_recent_conversation' };
  if (now - Date.parse(tail.created_at) < 30 * 60000) return { skipped: 'conversation_active' };
  if (rule.triggerConfig.checkedMessageId === human.id) return { skipped: 'already_reviewed' };
  if (now - Number(rule.triggerConfig.lastAttemptAt ?? 0) < 86400000) return { skipped: 'daily_limit' };
  const agent = getAgent(deps.db, agentId);
  if (!agent || agent.availability === 'dnd' || deps.queue?.isBusy(agentId)
    || deps.db.prepare("SELECT 1 FROM agent_runs WHERE agent_id = ? AND status IN ('running', 'queued') LIMIT 1").get(agentId)) return { skipped: 'agent_unavailable' };
  if (!getProviderConfig(deps.db, agent.modelPolicy.defaultProviderId)) return { skipped: 'provider_unavailable' };
  checkAccess();

  // Claim before the model call. Restart, overlapping ticks and failed calls do
  // not spend again on the same human message. No idle polling of the model.
  const row = deps.db.prepare('SELECT trigger_config FROM automations WHERE id = ? AND enabled = 1').get(rule.id) as { trigger_config: string } | undefined;
  if (!row) return { skipped: 'disabled' };
  const current = JSON.parse(row.trigger_config) as Record<string, unknown>;
  if (current.checkedMessageId === human.id || now - Number(current.lastAttemptAt ?? 0) < 86400000) return { skipped: 'already_reviewed' };
  const claimed = deps.db.prepare('UPDATE automations SET trigger_config = ? WHERE id = ? AND enabled = 1 AND trigger_config = ?')
    .run(JSON.stringify({ ...current, checkedMessageId: human.id, lastAttemptAt: now }), rule.id, row.trigger_config);
  if (!claimed.changes) return { skipped: 'already_claimed' };
  const shouldContinue = () => {
    try {
      checkAccess();
      return Boolean(deps.db.prepare('SELECT 1 FROM automations WHERE id = ? AND enabled = 1').get(rule.id))
        && getAgent(deps.db, agentId)?.availability === 'auto'
        && latest()?.id === tail.id;
    } catch { return false; }
  };
  try {
    const result = await runAgentTurn(deps, { agentId, conversationId, trigger: 'proactive', triggerMessageId: human.id,
      optional: true, proactive: true, proactiveFocus: rule.actions[0]?.type === 'invoke_agent' ? rule.actions[0].prompt : undefined, shouldContinue });
    return result.message ? { messageId: result.message.id, runId: result.run.runId } : { skipped: 'nothing_useful', runId: result.run.runId };
  } catch (error) {
    if (error instanceof RunCancelledError) return { skipped: 'context_changed' };
    throw error;
  }
}
