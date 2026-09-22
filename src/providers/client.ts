import type { ChatRequest, ChatResponse, ModelInfo, ProviderKind } from '../protocol/index.js';

/**
 * What a provider said about its own limits on the last answer, when it said
 * anything. Every provider spells these differently; this is the one shape.
 */
export interface RateLimitSnapshot {
  requestsRemaining?: number;
  tokensRemaining?: number;
  /** When the tighter of the two windows resets. */
  resetAt?: string;
}

export type ProviderChatResult = ChatResponse & { rateLimit?: RateLimitSnapshot };

export interface ProviderClient {
  readonly kind: ProviderKind;
  chat(request: ChatRequest): Promise<ProviderChatResult>;
  listModels(): Promise<ModelInfo[]>;
}

function numberHeader(headers: Headers, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = headers.get(name);
    if (value === null) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** OpenAI writes resets as durations: `1s`, `6m0s`, `250ms`. */
function durationMs(value: string): number | undefined {
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (parts.length === 0) return undefined;
  const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
  return parts.reduce((total, [, amount, suffix]) => total + Number(amount) * unit[suffix!]!, 0);
}

function resetHeader(headers: Headers, now: number): string | undefined {
  // Anthropic: an RFC 3339 time.
  const anthropic = headers.get('anthropic-ratelimit-requests-reset') ?? headers.get('anthropic-ratelimit-tokens-reset');
  if (anthropic && !Number.isNaN(Date.parse(anthropic))) return new Date(anthropic).toISOString();
  // OpenAI and the providers that copy it: a duration from now.
  const openai = headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset-tokens');
  if (openai) {
    const ms = durationMs(openai);
    if (ms !== undefined) return new Date(now + ms).toISOString();
  }
  // OpenRouter: epoch milliseconds.
  const epoch = numberHeader(headers, 'x-ratelimit-reset');
  if (epoch !== undefined && epoch > 1e12) return new Date(epoch).toISOString();
  return undefined;
}

export function readRateLimitHeaders(headers: Headers, now = Date.now()): RateLimitSnapshot | undefined {
  const snapshot: RateLimitSnapshot = {
    requestsRemaining: numberHeader(
      headers,
      'anthropic-ratelimit-requests-remaining',
      'x-ratelimit-remaining-requests',
      'x-ratelimit-remaining',
    ),
    tokensRemaining: numberHeader(headers, 'anthropic-ratelimit-tokens-remaining', 'x-ratelimit-remaining-tokens'),
    resetAt: resetHeader(headers, now),
  };
  return Object.values(snapshot).some((value) => value !== undefined) ? snapshot : undefined;
}
