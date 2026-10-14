import { z } from 'zod';
import type { Database } from '../db/driver.js';
import type { ToolsetProvider } from '../providers/respond.js';
import { isParticipant } from '../conversations/repository.js';
import { canReadChannel, blockedAgentIds } from '../channels/repository.js';
import { createAutomation, listAutomations, updateAutomation } from './service.js';

const ScheduleInput = z.object({
  name: z.string().trim().min(2).max(80),
  runAt: z.string().datetime({ offset: true }),
  intervalMinutes: z.number().int().min(1).max(10080).optional(),
  body: z.string().trim().min(1).max(100_000),
}).strict();

/** Bounded scheduling: only the requesting human, current conversation and current agent. */
export function automationToolset(db: Database, now: () => Date = () => new Date()): ToolsetProvider {
  return (agent, input) => {
    const latest = input.recentMessages.at(-1);
    if (input.allowArtifacts === false || latest?.authorType !== 'user') return undefined;
    const userId = latest.authorId;
    const conversationId = input.conversationId;
    const allowed = () => Boolean(db.prepare('SELECT 1 FROM users WHERE id = ? AND suspended_at IS NULL').get(userId))
      && (isParticipant(db, conversationId, userId, 'user') || canReadChannel(db, conversationId, userId))
      && isParticipant(db, conversationId, agent.id, 'agent') && !blockedAgentIds(db, conversationId).includes(agent.id);
    if (!allowed()) return undefined;
    const own = () => listAutomations(db).filter((rule) => rule.createdBy === userId
      && rule.triggerConfig.kind === 'conversation_schedule' && rule.triggerConfig.conversationId === conversationId
      && rule.triggerConfig.agentId === agent.id);
    const scheduleProperties = {
      name: { type: 'string', minLength: 2, maxLength: 80 },
      runAt: { type: 'string', description: 'First execution time as ISO 8601 with an explicit UTC offset. Use current_time/date_math for relative requests.' },
      intervalMinutes: { type: 'integer', minimum: 1, maximum: 10080, description: 'Omit for a one-time task. Set only when the user requested recurrence.' },
      body: { type: 'string', description: 'The message to deliver, or instructions for the future agent task, in the user\'s language.' },
    };
    return {
      instructions: 'For reminders or messages requested later, call schedule_message. For work requested later, call schedule_task. These persist on the Crewly server and run while the app is closed, provided the server is running. Confirm only after success, including the returned time and recurrence. Delivery can be up to one minute after the scheduled time. Do not schedule unsolicited follow-ups.',
      definitions: [
        { name: 'schedule_message', description: 'Save a one-time or recurring message/reminder for this conversation. Also creates a notification using the user\'s notification settings.', inputSchema: { type: 'object', properties: scheduleProperties, required: ['name', 'runAt', 'body'], additionalProperties: false } },
        { name: 'schedule_task', description: 'Schedule this agent to perform a task later and post its result in this conversation.', inputSchema: { type: 'object', properties: scheduleProperties, required: ['name', 'runAt', 'body'], additionalProperties: false } },
        { name: 'list_scheduled_tasks', description: 'List your saved reminders and tasks in this conversation, including whether they are enabled.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'cancel_scheduled_task', description: 'Cancel a saved reminder or task in this conversation using an ID from list_scheduled_tasks.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
      ],
      async execute(call) {
        try {
          if (!allowed()) throw new Error('schedule_access_revoked');
          if (call.name === 'list_scheduled_tasks') return { content: JSON.stringify({ tasks: own() }) };
          if (call.name === 'cancel_scheduled_task') {
            const { id } = z.object({ id: z.string().min(1) }).strict().parse(call.input);
            const task = own().find((rule) => rule.id === id);
            if (!task) throw new Error('scheduled_task_not_found');
            updateAutomation(db, id, { ...task, enabled: false });
            return { content: JSON.stringify({ id, cancelled: true }) };
          }
          if (call.name !== 'schedule_message' && call.name !== 'schedule_task') throw new Error('unknown_schedule_tool');
          const args = ScheduleInput.parse(call.input);
          if (Date.parse(args.runAt) <= now().getTime()) throw new Error('schedule_time_must_be_in_future');
          // Retries within the same turn must not create duplicate reminders.
          const requestKey = JSON.stringify({ call: call.name, ...args });
          const existing = input.run && own().find((rule) => rule.enabled
            && rule.triggerConfig.originRunId === input.run!.runId && rule.triggerConfig.requestKey === requestKey);
          const task = existing ?? createAutomation(db, {
            name: args.name, createdBy: userId, triggerType: 'schedule',
            triggerConfig: { kind: 'conversation_schedule', conversationId, agentId: agent.id,
              runAt: args.runAt, ...(args.intervalMinutes ? { intervalMinutes: args.intervalMinutes } : {}),
              originRunId: input.run?.runId, requestKey },
            actions: call.name === 'schedule_message'
              ? [{ type: 'post_message', conversationId, body: args.body }]
              : [{ type: 'invoke_agent', agentId: agent.id, conversationId, prompt: args.body }],
          }).automation;
          return { content: JSON.stringify({ saved: true, id: task.id, name: task.name, runAt: task.triggerConfig.runAt,
            intervalMinutes: task.triggerConfig.intervalMinutes ?? null, conversationId, delivery: 'conversation_and_configured_notifications' }) };
        } catch (error) {
          return { content: `Scheduling failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
      },
    };
  };
}
