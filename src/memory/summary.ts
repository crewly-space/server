import type { ConversationSummary, Message } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import { listRecentMessagesForConversation } from '../messages/repository.js';
import { getConversationSummary, upsertConversationSummary } from './summary-repository.js';

export const SUMMARIZE_CONVERSATION_JOB_TYPE = 'summarize-conversation';

export type SummarizeFn = (input: {
  conversationId: string;
  priorSummary: string | null;
  messages: Message[];
}) => Promise<string>;

const MAX_SUMMARY_MESSAGES = 20;
const MAX_SUMMARY_LENGTH = 2000;

export const defaultSummarize: SummarizeFn = async ({ priorSummary, messages }) => {
  const recap = messages.map((m) => `${m.authorType}:${m.authorId}: ${m.body}`).join('\n');
  const combined = priorSummary ? `${priorSummary}\n${recap}` : recap;
  return combined.length > MAX_SUMMARY_LENGTH ? combined.slice(combined.length - MAX_SUMMARY_LENGTH) : combined;
};

export async function updateConversationSummary(
  db: Database,
  conversationId: string,
  summarize: SummarizeFn = defaultSummarize
): Promise<ConversationSummary | undefined> {
  const messages = listRecentMessagesForConversation(db, conversationId, MAX_SUMMARY_MESSAGES);
  if (messages.length === 0) return undefined;

  const prior = getConversationSummary(db, conversationId);
  const summaryText = await summarize({
    conversationId,
    priorSummary: prior?.summary ?? null,
    messages,
  });

  return upsertConversationSummary(db, {
    conversationId,
    summary: summaryText,
    upToMessageId: messages[messages.length - 1].id,
  });
}
