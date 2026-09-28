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

/** Plural, tense and -ing forms read as one word: tests, testing, tested → test. */
function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
}

/**
 * Words that point at the same kind of work, so "how are the tests going"
 * finds the agent whose role says QA. Deliberately small and plain; an agent's
 * own role and instructions still do most of the matching.
 */
const TOPICS: Record<string, string[]> = {
  testing: ['test', 'qa', 'quality', 'coverage', 'regression', 'e2e', 'flaky', 'spec', 'tester'],
  release: ['deploy', 'deployment', 'release', 'ship', 'rollout', 'devops', 'infra', 'infrastructure', 'pipeline', 'ci', 'outage', 'incident', 'sre', 'uptime', 'docker', 'kubernete'],
  engineering: ['code', 'bug', 'fix', 'implement', 'feature', 'refactor', 'backend', 'frontend', 'fullstack', 'developer', 'develop', 'pr', 'merge', 'build', 'api', 'programm', 'coding'],
  design: ['design', 'designer', 'ui', 'ux', 'mockup', 'figma', 'layout', 'wireframe', 'prototype'],
  research: ['research', 'researcher', 'investigate', 'compare', 'comparison', 'study', 'source', 'find'],
  writing: ['doc', 'docs', 'documentation', 'write', 'writer', 'writing', 'blog', 'copy', 'copywriter', 'content', 'readme', 'draft', 'article', 'editor'],
  data: ['data', 'analytic', 'metric', 'dashboard', 'report', 'sql', 'query', 'analyst', 'analysis', 'kpi'],
  product: ['roadmap', 'plan', 'planning', 'priority', 'prioritize', 'product', 'requirement', 'sprint', 'backlog', 'pm'],
  security: ['security', 'vulnerability', 'secure', 'audit', 'cve', 'pentest'],
  support: ['customer', 'support', 'ticket', 'complaint', 'refund', 'helpdesk'],
  marketing: ['marketing', 'marketer', 'campaign', 'seo', 'social', 'launch', 'growth', 'newsletter'],
  sales: ['sale', 'sales', 'deal', 'prospect', 'crm', 'pipeline'],
  assistant: ['schedule', 'calendar', 'email', 'remind', 'reminder', 'meeting', 'assistant', 'inbox'],
};
const TOPIC_OF = new Map<string, string[]>();
for (const [topic, words] of Object.entries(TOPICS)) {
  for (const word of words) TOPIC_OF.set(stem(word), [...(TOPIC_OF.get(stem(word)) ?? []), topic]);
}

/** Small talk and job-title filler that says nothing about whose work it is. */
const FILLER = new Set([
  'the', 'can', 'could', 'would', 'should', 'how', 'what', 'when', 'where', 'who', 'why', 'which', 'any', 'anyone', 'someone',
  'everyone', 'all', 'our', 'we', 'is', 'it', 'its', 'for', 'of', 'on', 'in', 'to', 'yet', 'now', 'today', 'please', 'thanks',
  'going', 'doing', 'done', 'get', 'got', 'let', 'know', 'hey', 'hi', 'hello', 'good', 'morning', 'there', 'here', 'up',
  'engineer', 'engineering', 'lead', 'senior', 'junior', 'specialist', 'manager', 'agent', 'helper', 'bot',
]);

function concepts(value: string): Set<string> {
  const out = new Set<string>();
  for (const raw of value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []) {
    if (STOP_WORDS.has(raw) || FILLER.has(raw)) continue;
    const word = stem(raw);
    if (word.length >= 3) out.add(word);
    for (const topic of TOPIC_OF.get(word) ?? []) out.add(`#${topic}`);
  }
  return out;
}

/**
 * The one agent a message is plainly about, when nobody is addressed: a
 * person asking "how are the tests going" in a room of agents expects the QA
 * colleague to answer. The role (the first line of the personality) counts
 * double. A tie or no match picks nobody, so chatter stays quiet.
 */
export function pickMessageOwner(agents: Array<{ agentId: string; agent: Pick<Agent, 'name' | 'personality'> }>, body: string): string | undefined {
  const message = concepts(body);
  if (!message.size) return undefined;
  const scored = agents.map(({ agentId, agent }) => {
    const [role = '', ...rest] = agent.personality.split('\n');
    const primary = concepts(`${agent.name} ${role}`);
    const secondary = concepts(rest.join(' '));
    let score = 0;
    for (const concept of message) score += primary.has(concept) ? 2 : secondary.has(concept) ? 1 : 0;
    return { agentId, score };
  }).sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score === 0 || (next && next.score === best.score)) return undefined;
  return best.agentId;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the message says the agent's name the way a person addresses a
 * colleague ("Alpha, can you…", "thanks alpha"), without the @ picker.
 */
export function messageNamesAgent(agent: Pick<Agent, 'name'>, body: string): boolean {
  const name = agent.name.trim();
  if (name.length < 2) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'iu').test(body);
}

/**
 * What the conversation around a message says about who it is meant for.
 * Agents are colleagues: one who was just talking, whose message is being
 * answered, or who is working in the thread, hears a follow-up without an @.
 */
export interface ConversationCues {
  /** The message says the agent's name. */
  named?: boolean;
  /** The message replies to one of the agent's messages. */
  repliedTo?: boolean;
  /** The agent spoke last, recently, and the person is carrying on. */
  followUp?: boolean;
  /** The agent is the one working in this thread. */
  inThread?: boolean;
  /** Nobody is addressed and the message is plainly about this agent's work. */
  owner?: boolean;
  /** The message addresses some other agent, by @ or by name. */
  addressedElsewhere?: boolean;
}

export interface RoutingDecision {
  shouldRespond: boolean;
  mode: AgentRoutingMode;
  reason: 'explicit_mention' | 'named' | 'replied_to' | 'follow_up' | 'thread' | 'owner' | 'always' | 'relevant' | 'irrelevant' | 'mention_only' | 'disabled' | 'blocked' | 'dnd' | 'classifier_unavailable';
}

export function decideAgentRouting(
  agent: Pick<Agent, 'name' | 'personality' | 'availability'>,
  mode: AgentRoutingMode,
  body: string,
  explicitlyMentioned: boolean,
  blocked: boolean,
  directMessage = false,
  cues: ConversationCues = {},
): RoutingDecision {
  // An explicit address is a direct request. Channel blocks are the permission
  // boundary and therefore win even over a mention.
  if (blocked) return { shouldRespond: false, mode, reason: 'blocked' };
  if (directMessage) return { shouldRespond: true, mode, reason: 'always' };
  if (explicitlyMentioned) return { shouldRespond: true, mode, reason: 'explicit_mention' };
  if (agent.availability === 'dnd') return { shouldRespond: false, mode, reason: 'dnd' };
  if (mode === 'disabled') return { shouldRespond: false, mode, reason: 'disabled' };
  // Being spoken to by name or answered directly is being addressed, @ or not.
  if (cues.named) return { shouldRespond: true, mode, reason: 'named' };
  if (cues.repliedTo) return { shouldRespond: true, mode, reason: 'replied_to' };
  // Carrying on a conversation reaches whoever it is with, unless the person
  // has just turned to someone else.
  if (!cues.addressedElsewhere) {
    if (cues.inThread) return { shouldRespond: true, mode, reason: 'thread' };
    if (cues.followUp) return { shouldRespond: true, mode, reason: 'follow_up' };
    if (cues.owner) return { shouldRespond: true, mode, reason: 'owner' };
  }
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
  return { shouldRespond: false, mode, reason: 'mention_only' };
}
