import type { RateLimitSnapshot } from '../providers/client.js';

export interface ProviderRateLimitState extends RateLimitSnapshot {
  /** Set after a 429: the provider asked not to be called again before this. */
  limitedUntil?: string;
  observedAt: string;
}

/**
 * The last thing each provider said about its limits.
 *
 * Kept in memory: it is only true for a few seconds, and a restart that forgets
 * it loses nothing -- the next answer carries it again.
 */
export class RateLimitBoard {
  private readonly states = new Map<string, ProviderRateLimitState>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A successful answer: record what it said, and any earlier back-off is over. */
  observe(providerId: string, snapshot: RateLimitSnapshot | undefined): void {
    if (!snapshot) {
      this.cleared(providerId);
      return;
    }
    this.states.set(providerId, { ...snapshot, observedAt: new Date(this.now()).toISOString() });
  }

  limited(providerId: string, retryAfterMs: number | undefined): void {
    const previous = this.states.get(providerId);
    const until = new Date(this.now() + (retryAfterMs ?? 30_000)).toISOString();
    this.states.set(providerId, {
      ...previous,
      limitedUntil: until,
      observedAt: new Date(this.now()).toISOString(),
    });
  }

  cleared(providerId: string): void {
    const previous = this.states.get(providerId);
    if (previous?.limitedUntil) this.states.set(providerId, { ...previous, limitedUntil: undefined });
  }

  get(providerId: string): ProviderRateLimitState | undefined {
    const state = this.states.get(providerId);
    if (state?.limitedUntil && Date.parse(state.limitedUntil) <= this.now()) {
      return { ...state, limitedUntil: undefined };
    }
    return state;
  }
}
