import type { AiGateway, GatewayTarget } from '../gateway/gateway.js';

/** An agent the router may pick, as the router describes it to the model. */
export interface ReplyCandidate {
  agentId: string;
  name: string;
  /** The first line of the personality. */
  role: string;
  /** The rest of the personality, shortened. */
  instructions: string;
  /** Busy with another run; picking it queues the reply behind that work. */
  busy: boolean;
}

export interface ReplyRouterInput {
  conversationId: string;
  /** The latest messages, oldest first, as "Name: text" lines; the last is the one to route. */
  transcript: string[];
  candidates: ReplyCandidate[];
  /** The model that makes the call, and whose account it is metered to. */
  target: GatewayTarget;
  ownerUserId: string;
}

/** Picks which agents answer a message nobody addressed. Empty means nobody. */
export type ReplyRouter = (input: ReplyRouterInput) => Promise<string[]>;

/** Never more than this many agents answer one unaddressed message. */
export const MAX_PICKED_AGENTS = 2;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export function replyRouterPrompt(input: Pick<ReplyRouterInput, 'transcript' | 'candidates'>): string {
  const agents = input.candidates.map((candidate, index) =>
    `${index + 1}. ${candidate.name}${candidate.role ? ` — ${clip(candidate.role, 120)}` : ''}${candidate.busy ? ' (busy with other work)' : ''}${candidate.instructions ? `\n   ${clip(candidate.instructions.replace(/\s+/g, ' '), 240)}` : ''}`,
  ).join('\n');
  return [
    'You route messages in a team chat where people work with AI agents as colleagues.',
    'Decide which agents, if any, should reply to the LAST message. Agents are listed with their roles:',
    agents,
    '',
    'Recent conversation, oldest first:',
    ...input.transcript.map((line) => clip(line, 500)),
    '',
    'Rules: pick the one agent whose work the message is about, or who the person is plainly still talking to.',
    `Pick more than one only if the message clearly needs several of them (at most ${MAX_PICKED_AGENTS}).`,
    'Pick nobody for small talk, messages meant for people, or anything no agent is suited to.',
    'Prefer an agent that is not busy when two fit equally well.',
    'Answer with the agent numbers separated by commas (for example "2" or "1,3"), or NONE. No other text.',
  ].join('\n');
}

/** Reads "2", "1, 3", "Agent 2" or "NONE" back into agent ids. */
export function parseReplyRouterAnswer(answer: string, candidates: ReplyCandidate[]): string[] {
  if (/\bnone\b/i.test(answer) && !/\d/.test(answer)) return [];
  const picked: string[] = [];
  for (const match of answer.match(/\d+/g) ?? []) {
    const candidate = candidates[Number(match) - 1];
    if (candidate && !picked.includes(candidate.agentId)) picked.push(candidate.agentId);
    if (picked.length === MAX_PICKED_AGENTS) break;
  }
  return picked;
}

/** A router that asks a model: one short call per unaddressed message. */
export function createModelReplyRouter(gateway: AiGateway): ReplyRouter {
  return async (input) => {
    const response = await gateway.chat({
      target: input.target,
      messages: [{ role: 'user', content: replyRouterPrompt(input) }],
      maxTokens: 16,
      context: { purpose: 'reply_routing', ownerUserId: input.ownerUserId, conversationId: input.conversationId },
    });
    return parseReplyRouterAnswer(response.content, input.candidates);
  };
}
