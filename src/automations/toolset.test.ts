import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqlite, type Database } from '../db/driver.js';
import { runMigrations } from '../db/migrate.js';
import { createUser } from '../users/repository.js';
import { createAgent } from '../agents/repository.js';
import { createConversation, removeParticipant } from '../conversations/repository.js';
import { createMessage, listRecentMessagesForConversation } from '../messages/repository.js';
import { ConnectionHub } from '../ws/hub.js';
import { automationToolset } from './toolset.js';
import { createAutomation, dispatchAutomationEvent, getAutomation, listAutomationRuns, runDueSchedules } from './service.js';
import type { AgentToolset } from '../providers/respond.js';
import type { RespondInput } from '../runtime/engine.js';
import { createProviderConfig } from '../providers/repository.js';
import { createProviderRespond } from '../providers/respond.js';

describe('conversation scheduling', () => {
  let db: Database;
  let hub: ConnectionHub;
  let user: ReturnType<typeof createUser>;
  let agent: ReturnType<typeof createAgent>;
  let conversationId: string;
  let tools: AgentToolset;
  const now = new Date('2026-09-30T12:00:00Z');
  const respond = vi.fn(async (_input: RespondInput) => ({ body: 'Gotowe.' }));
  const call = (name: string, input: Record<string, unknown> = {}) => tools.execute({ id: 'call', name, input });
  const reminder = { name: 'Przypomnienie', runAt: '2026-09-30T15:00:00+02:00', body: 'Czas na przerwę.' };
  const deps = () => ({ db, hub, respond });

  beforeEach(async () => {
    db = openSqlite(':memory:'); db.pragma('foreign_keys = ON'); runMigrations(db);
    hub = new ConnectionHub(db);
    user = createUser(db, { email: 'owner@example.com', displayName: 'Owner', passwordHash: 'x', role: 'owner' });
    agent = createAgent(db, { ownerUserId: user.id, name: 'Assistant', personality: '', modelPolicy: { defaultProviderId: 'p', defaultModel: 'm' }, permissions: { tools: [], canMessageAgents: true, canApproveOwnActions: false } });
    conversationId = createConversation(db, { kind: 'dm', name: null, participants: [{ participantId: user.id, participantType: 'user' }, { participantId: agent.id, participantType: 'agent' }] }).id;
    const message = createMessage(db, { conversationId, authorId: user.id, authorType: 'user', body: 'Napisz za godzinę.', mentions: [], replyToMessageId: null });
    tools = (await automationToolset(db, () => now)(agent, { agentId: agent.id, conversationId, recentMessages: [message], run: { runId: 'r1', rootRunId: 'r1', hopCount: 0 } }))!;
    respond.mockClear();
  });
  afterEach(() => db.close());

  it('saves a one-shot, deduplicates retries, waits until due, and delivers only once', async () => {
    const saved = JSON.parse((await call('schedule_message', reminder)).content);
    expect(saved).toMatchObject({ saved: true, runAt: '2026-09-30T13:00:00.000Z', intervalMinutes: null });
    expect(JSON.parse((await call('schedule_message', reminder)).content).id).toBe(saved.id);
    await runDueSchedules(deps(), new Date('2026-09-30T12:59:59Z'));
    expect(listAutomationRuns(db)).toHaveLength(0);
    await runDueSchedules(deps(), new Date('2026-09-30T13:00:00Z'));
    // A new scheduler after a restart sees the same persisted disabled task/run.
    await runDueSchedules(deps(), new Date('2026-10-01T13:00:00Z'));
    expect(listAutomationRuns(db)).toHaveLength(1);
    expect(getAutomation(db, saved.id)?.enabled).toBe(false);
    expect(listRecentMessagesForConversation(db, conversationId).map((m) => m.body)).toEqual(['Napisz za godzinę.', reminder.body]);
  });

  it('does not run unrelated schedules and anchors recurring work to the requested time', async () => {
    const first = JSON.parse((await call('schedule_message', { ...reminder, intervalMinutes: 120 })).content);
    const later = JSON.parse((await call('schedule_message', { ...reminder, name: 'Later task', runAt: '2026-09-30T18:00:00Z', intervalMinutes: 240 })).content);
    await runDueSchedules(deps(), new Date('2026-09-30T13:00:00Z'));
    await runDueSchedules(deps(), new Date('2026-09-30T14:59:59Z'));
    expect(listAutomationRuns(db).map((r) => r.automationId)).toEqual([first.id]);
    await runDueSchedules(deps(), new Date('2026-09-30T15:00:00Z'));
    expect(listAutomationRuns(db)).toHaveLength(2);
    expect(listAutomationRuns(db, later.id)).toHaveLength(0);
  });

  it('catches up a missed one-shot after downtime and invokes the agent for scheduled work', async () => {
    await call('schedule_task', { ...reminder, body: 'Przygotuj podsumowanie.' });
    await runDueSchedules(deps(), new Date('2026-10-01T12:00:00Z'));
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]?.recentMessages.at(-1)?.body).toBe('Przygotuj podsumowanie.');
    expect(listAutomationRuns(db)[0]?.status).toBe('succeeded');
  });

  it('cancels only tasks belonging to this user, agent and conversation', async () => {
    const saved = JSON.parse((await call('schedule_message', reminder)).content);
    const unrelated = createAutomation(db, { createdBy: user.id, name: 'Admin rule', triggerType: 'schedule', actions: [{ type: 'post_message', conversationId, body: 'Admin' }] }).automation;
    expect((await call('cancel_scheduled_task', { id: unrelated.id })).isError).toBe(true);
    expect(JSON.parse((await call('list_scheduled_tasks')).content).tasks.map((t: { id: string }) => t.id)).toEqual([saved.id]);
    expect(JSON.parse((await call('cancel_scheduled_task', { id: saved.id })).content).cancelled).toBe(true);
    await runDueSchedules(deps(), new Date('2026-09-30T13:00:00Z'));
    expect(listAutomationRuns(db, saved.id)).toHaveLength(0);
  });

  it('rejects invalid times and rechecks access before creation and delivery', async () => {
    for (const runAt of ['tomorrow', '2026-09-30T11:00:00Z', '2026-09-30T13:00:00']) {
      expect((await call('schedule_message', { ...reminder, runAt })).isError).toBe(true);
    }
    const saved = JSON.parse((await call('schedule_message', reminder)).content);
    removeParticipant(db, conversationId, user.id);
    expect((await call('schedule_message', { ...reminder, name: 'Another' })).isError).toBe(true);
    await runDueSchedules(deps(), new Date('2026-09-30T13:00:00Z'));
    expect(listAutomationRuns(db, saved.id)[0]).toMatchObject({ status: 'failed', error: 'schedule_access_revoked' });
    expect(listRecentMessagesForConversation(db, conversationId)).toHaveLength(1);
  });

  it('targets webhook rules so one secret cannot trigger another automation', async () => {
    const a = createAutomation(db, { createdBy: user.id, name: 'Webhook A', triggerType: 'webhook', actions: [{ type: 'post_message', conversationId, body: 'A' }] }).automation;
    const b = createAutomation(db, { createdBy: user.id, name: 'Webhook B', triggerType: 'webhook', actions: [{ type: 'post_message', conversationId, body: 'B' }] }).automation;
    await dispatchAutomationEvent(deps(), { type: 'webhook', automationId: a.id, dedupeKey: 'event', payload: {} });
    expect(listAutomationRuns(db, a.id)).toHaveLength(1);
    expect(listAutomationRuns(db, b.id)).toHaveLength(0);
  });

  it('does not expose scheduling during a delegated or automation turn', async () => {
    const message = listRecentMessagesForConversation(db, conversationId)[0]!;
    const provide = automationToolset(db, () => now);
    expect(await provide(agent, { agentId: agent.id, conversationId, recentMessages: [message], allowArtifacts: false })).toBeUndefined();
    expect(await provide(agent, { agentId: agent.id, conversationId, recentMessages: [{ ...message, authorType: 'integration' }] })).toBeUndefined();
  });

  it('lets a model save a reminder through the normal tool loop and read its actual result', async () => {
    createProviderConfig(db, { id: 'p', kind: 'anthropic', apiKey: 'sk-test' });
    const requests: Array<{ system: string; tools: Array<{ name: string }>; messages: Array<{ content: unknown }> }> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(requests.length === 1
        ? { content: [{ type: 'tool_use', id: 'save', name: 'schedule_message', input: reminder }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }
        : { content: [{ type: 'text', text: 'Zapisane na 15:00.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    }) as unknown as typeof fetch;
    const respondToUser = createProviderRespond(db, fetchImpl, undefined, { toolsets: [automationToolset(db, () => now)] });
    const result = await respondToUser({ agentId: agent.id, conversationId, recentMessages: listRecentMessagesForConversation(db, conversationId) });
    expect(result.body).toBe('Zapisane na 15:00.');
    expect(requests[0]!.system).toContain('language of the latest human message');
    expect(requests[0]!.tools.map((t) => t.name)).toContain('schedule_message');
    const outcome = requests[1]!.messages.at(-1)!.content as Array<{ type: string; content: string }>;
    expect(outcome[0]?.type).toBe('tool_result');
    expect(JSON.parse(outcome[0]!.content)).toMatchObject({ saved: true, runAt: '2026-09-30T13:00:00.000Z' });
    expect(JSON.parse((await call('list_scheduled_tasks')).content).tasks).toHaveLength(1);
  });
});
