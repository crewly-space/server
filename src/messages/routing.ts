import type { Agent, AgentRoutingMode } from '../protocol/index.js';

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'from', 'have', 'into', 'just',
  'more', 'only', 'that', 'their', 'them', 'then', 'this', 'with', 'you', 'your',
]);

function tokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g)?.filter((token) => !STOP_WORDS.has(token)) ?? []);
}

/**
 * A deliberately cheap classifier: it compares the message with the agent's
 * name and personality before a full provider run. If an agent has no useful
 * profile words, it returns false and the caller can retain the safe default.
 */
export function messageIsRelevantToAgent(agent: Pick<Agent, 'name' | 'personality'>, body: string): boolean {
  const profile = tokens(`${agent.name} ${agent.personality}`);
  const message = tokens(body);
  if (!profile.size || !message.size) return false;
  let matches = 0;
  for (const token of message) if (profile.has(token)) matches += 1;
  return matches > 0;
}

export interface RoutingDecision {
  shouldRespond: boolean;
  mode: AgentRoutingMode;
  reason: 'explicit_mention' | 'always' | 'relevant' | 'irrelevant' | 'mention_only' | 'disabled' | 'blocked' | 'dnd' | 'classifier_unavailable';
}

export function decideAgentRouting(
  agent: Pick<Agent, 'name' | 'personality' | 'availability'>,
  mode: AgentRoutingMode,
  body: string,
  explicitlyMentioned: boolean,
  blocked: boolean,
  directMessage = false,
): RoutingDecision {
  // An explicit address is a direct request. Channel blocks are the permission
  // boundary and therefore win even over a mention.
  if (blocked) return { shouldRespond: false, mode, reason: 'blocked' };
  if (directMessage) return { shouldRespond: true, mode, reason: 'always' };
  if (explicitlyMentioned) return { shouldRespond: true, mode, reason: 'explicit_mention' };
  if (agent.availability === 'dnd') return { shouldRespond: false, mode, reason: 'dnd' };
  if (mode === 'always') return { shouldRespond: true, mode, reason: 'always' };
  if (mode === 'relevant') {
    try {
      const relevant = messageIsRelevantToAgent(agent, body);
      return { shouldRespond: relevant, mode, reason: relevant ? 'relevant' : 'irrelevant' };
    } catch {
      // A classifier must never become a message-loss boundary. If the cheap
      // path is unavailable, wake every otherwise allowed agent safely.
      return { shouldRespond: true, mode, reason: 'classifier_unavailable' };
    }
  }
  return { shouldRespond: false, mode, reason: mode === 'disabled' ? 'disabled' : 'mention_only' };
}
