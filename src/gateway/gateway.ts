import { AGENTD_BACKED_PROVIDER_KINDS, type ChatMessage, type ProviderKind, type ToolDefinition } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import type { DeviceConnectionHub } from '../devices/hub.js';
import type { ProviderChatResult } from '../providers/client.js';
import { ProviderError, ProviderNotConfiguredError, ProviderRateLimitError, ProviderUnavailableError } from '../providers/errors.js';
import { resolveProviderClient } from '../providers/registry.js';
import { getProviderConfig, type ProviderConfigRecord } from '../providers/repository.js';
import { recordProviderCall, type ProviderCallRecord } from './meter.js';
import { RateLimitBoard } from './rate-limits.js';

/** Which provider and model to call. */
export interface GatewayTarget {
  providerId: string;
  model: string;
}

/** Who the call is on behalf of. Everything here ends up on the meter. */
export interface GatewayContext {
  purpose: string;
  /** The user whose paired devices serve device-backed providers. */
  ownerUserId: string;
  agentId?: string;
  runId?: string;
  rootRunId?: string;
  conversationId?: string;
  /** Hears each attempt, retry and fallback as it happens, for the run trace. */
  onEvent?: (event: GatewayEvent) => void;
}

export interface GatewayRequest {
  target: GatewayTarget;
  /** Tried once the primary target has failed for good. */
  fallback?: GatewayTarget;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  context: GatewayContext;
}

export type GatewayEvent =
  | {
      type: 'provider.call';
      callId: string;
      providerId: string;
      model: string;
      attempt: number;
      fallback: boolean;
      status: 'ok' | 'error';
      errorCode: string | null;
      latencyMs: number;
      inputTokens: number;
      outputTokens: number;
      costMicros: number | null;
    }
  | { type: 'provider.retry'; providerId: string; model: string; attempt: number; delayMs: number; errorCode: string }
  | { type: 'provider.fallback'; from: GatewayTarget; to: GatewayTarget; reason: string }
  | { type: 'gateway.blocked'; providerId: string; model: string; code: string; reason: string };

export interface GatewayResult extends ProviderChatResult {
  /** Where the answer actually came from, which is not always where it was asked. */
  target: GatewayTarget;
  usedFallback: boolean;
  attempts: number;
}

/**
 * Consulted before every call. It may let the call through, send it to the
 * fallback target instead, or refuse it -- budgets are the first user.
 */
export type GatewayGuard = (
  target: GatewayTarget,
  context: GatewayContext,
  /** True when `target` is already the fallback, so a guard can let a cheaper model through. */
  meta: { isFallback: boolean },
) =>
  | { action: 'allow' }
  /** Use the fallback target instead; `error` is thrown when there is none. */
  | { action: 'fallback'; reason: string; error: ProviderError }
  | { action: 'block'; error: ProviderError };

/** Hears every metered call once it is recorded -- budgets use it to raise alerts. */
export type GatewayCallListener = (record: ProviderCallRecord) => void;

/** Prices a finished call, in millionths of a dollar; null when the model has no price. */
export type GatewayPricer = (kind: ProviderKind, model: string, usage: { inputTokens: number; outputTokens: number }) => number | null;

export interface AiGatewayOptions {
  db: Database;
  fetchImpl?: typeof fetch;
  deviceHub?: DeviceConnectionHub;
  /** Attempts per target, including the first. */
  maxAttempts?: number;
  /** First retry delay; each later one doubles. */
  baseDelayMs?: number;
  /**
   * The longest a rate limit is waited out in place. A provider asking for
   * longer is treated as failed, so the fallback can answer instead of the
   * person watching a spinner for a minute.
   */
  maxRetryWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isDeviceBacked(kind: ProviderKind): boolean {
  return (AGENTD_BACKED_PROVIDER_KINDS as readonly ProviderKind[]).includes(kind);
}

/**
 * The same conversation for a provider that cannot take tools: calls and their
 * results become plain text, so a fallback to a device-backed model still sees
 * what happened rather than a request it would reject.
 */
export function withoutTools(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'user', content: `Tool result${message.isError ? ' (error)' : ''}: ${message.content}` };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const calls = message.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.input)})`).join(', ');
      return { role: 'assistant', content: [message.content, `[called ${calls}]`].filter(Boolean).join('\n') };
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * The one way Crewly talks to a model.
 *
 * It wraps the provider registry rather than replacing it: every provider kind
 * still has its own client, and the gateway adds what should be the same for
 * all of them -- retries on what is worth retrying, one error vocabulary, a
 * fallback target, rate-limit tracking, and a meter row for every attempt.
 */
export class AiGateway {
  readonly rateLimits: RateLimitBoard;
  private readonly guards: GatewayGuard[] = [];
  private readonly listeners: GatewayCallListener[] = [];
  private pricer: GatewayPricer = () => null;
  private readonly db: Database;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: AiGatewayOptions) {
    this.db = options.db;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.rateLimits = new RateLimitBoard(this.now);
  }

  use(guard: GatewayGuard): void {
    this.guards.push(guard);
  }

  setPricer(pricer: GatewayPricer): void {
    this.pricer = pricer;
  }

  onCall(listener: GatewayCallListener): void {
    this.listeners.push(listener);
  }

  async chat(request: GatewayRequest): Promise<GatewayResult> {
    const { context } = request;
    let target = request.target;
    let fallback = request.fallback;
    let usedFallback = false;

    for (;;) {
      const verdict = this.consultGuards(target, context, usedFallback);
      if (verdict.action === 'fallback' && fallback && !usedFallback) {
        context.onEvent?.({ type: 'provider.fallback', from: target, to: fallback, reason: verdict.reason });
        target = fallback;
        fallback = undefined;
        usedFallback = true;
        continue;
      }
      if (verdict.action !== 'allow') {
        const error = verdict.error;
        context.onEvent?.({
          type: 'gateway.blocked', providerId: target.providerId, model: target.model,
          code: error.code, reason: error.message,
        });
        throw error;
      }

      try {
        const result = await this.callWithRetries(target, request, usedFallback);
        return { ...result.response, target, usedFallback, attempts: result.attempts };
      } catch (error) {
        if (!(error instanceof ProviderError) || !fallback || usedFallback) throw error;
        context.onEvent?.({ type: 'provider.fallback', from: target, to: fallback, reason: error.code });
        target = fallback;
        fallback = undefined;
        usedFallback = true;
      }
    }
  }

  private consultGuards(target: GatewayTarget, context: GatewayContext, isFallback: boolean): ReturnType<GatewayGuard> {
    for (const guard of this.guards) {
      const verdict = guard(target, context, { isFallback });
      if (verdict.action !== 'allow') return verdict;
    }
    return { action: 'allow' };
  }

  private async callWithRetries(
    target: GatewayTarget,
    request: GatewayRequest,
    fallback: boolean,
  ): Promise<{ response: ProviderChatResult; attempts: number }> {
    const config = getProviderConfig(this.db, target.providerId);
    if (!config) throw new ProviderNotConfiguredError(`no provider configured with id "${target.providerId}"`);

    const maxAttempts = this.options.maxAttempts ?? 3;
    const baseDelayMs = this.options.baseDelayMs ?? 250;
    const maxRetryWaitMs = this.options.maxRetryWaitMs ?? 10_000;

    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await this.callOnce(config, target, request, attempt, fallback);
        return { response, attempts: attempt };
      } catch (error) {
        const normalized = error instanceof ProviderError
          ? error
          : new ProviderUnavailableError(`${config.kind} failed: ${(error as Error).message}`);
        if (!normalized.retryable || attempt >= maxAttempts) throw normalized;
        const wanted = normalized instanceof ProviderRateLimitError ? normalized.retryAfterMs : undefined;
        if (wanted !== undefined && wanted > maxRetryWaitMs) throw normalized;
        const delayMs = wanted ?? baseDelayMs * 2 ** (attempt - 1);
        request.context.onEvent?.({
          type: 'provider.retry', providerId: target.providerId, model: target.model,
          attempt, delayMs, errorCode: normalized.code,
        });
        await this.sleep(delayMs);
      }
    }
  }

  private async callOnce(
    config: ProviderConfigRecord,
    target: GatewayTarget,
    request: GatewayRequest,
    attempt: number,
    fallback: boolean,
  ): Promise<ProviderChatResult> {
    const { context } = request;
    const deviceBacked = isDeviceBacked(config.kind);
    const started = this.now();
    let response: ProviderChatResult | undefined;
    let failure: ProviderError | undefined;
    try {
      const client = resolveProviderClient(
        config,
        this.fetchImpl,
        this.options.deviceHub ? { db: this.db, hub: this.options.deviceHub, ownerUserId: context.ownerUserId } : undefined,
      );
      response = await client.chat({
        providerId: target.providerId,
        model: target.model,
        messages: deviceBacked ? withoutTools(request.messages) : request.messages,
        maxTokens: request.maxTokens,
        ...(request.tools?.length && !deviceBacked ? { tools: request.tools } : {}),
      });
      return response;
    } catch (error) {
      failure = error instanceof ProviderError
        ? error
        : new ProviderUnavailableError(`${config.kind} failed: ${(error as Error).message}`);
      throw failure;
    } finally {
      const usage = response?.usage ?? { inputTokens: 0, outputTokens: 0 };
      const costMicros = response ? this.pricer(config.kind, target.model, usage) : null;
      const record = recordProviderCall(this.db, {
        providerId: target.providerId,
        providerKind: config.kind,
        model: target.model,
        purpose: context.purpose,
        agentId: context.agentId ?? null,
        runId: context.runId ?? null,
        rootRunId: context.rootRunId ?? null,
        conversationId: context.conversationId ?? null,
        attempt,
        fallback,
        status: failure ? 'error' : 'ok',
        errorCode: failure?.code ?? null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicros,
        latencyMs: Math.max(0, this.now() - started),
      });
      for (const listener of this.listeners) {
        try {
          listener(record);
        } catch {
          // A listener is bookkeeping; it must never turn an answer into a failure.
        }
      }
      if (failure instanceof ProviderRateLimitError) this.rateLimits.limited(target.providerId, failure.retryAfterMs);
      else if (response) this.rateLimits.observe(target.providerId, response.rateLimit);
      context.onEvent?.({
        type: 'provider.call',
        callId: record.id,
        providerId: target.providerId,
        model: target.model,
        attempt,
        fallback,
        status: record.status,
        errorCode: record.errorCode,
        latencyMs: record.latencyMs,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        costMicros: record.costMicros,
      });
    }
  }
}
