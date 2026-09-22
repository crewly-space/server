/**
 * Every provider failure, in one vocabulary.
 *
 * `code` is stable and safe to show or match on; `retryable` says whether the
 * same call could succeed if made again. The gateway retries on that and
 * nothing else, so a wrong key or an unknown model fails once, not three times.
 */
export class ProviderError extends Error {
  readonly code: string = 'provider_error';
  readonly retryable: boolean = false;
}
export class ProviderUnavailableError extends ProviderError {
  override readonly code: string = 'provider_unavailable';
  override readonly retryable: boolean = true;
}
export class ProviderAuthError extends ProviderError {
  override readonly code: string = 'provider_auth_failed';
}
export class ProviderRateLimitError extends ProviderError {
  override readonly code: string = 'provider_rate_limited';
  override readonly retryable: boolean = true;
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}
/** The provider understood the request and refused it: an unknown model, a malformed body. */
export class ProviderRequestError extends ProviderError {
  override readonly code: string = 'provider_bad_request';
}
/** Nothing to call: the agent points at a provider that does not exist here. */
export class ProviderNotConfiguredError extends ProviderError {
  override readonly code: string = 'provider_not_configured';
}

/** Seconds or an HTTP date, as `Retry-After` allows; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The HTTP status of a failed provider call, as the error the gateway understands. */
export function errorForStatus(label: string, response: Response): ProviderError {
  const { status } = response;
  if (status === 401 || status === 403) return new ProviderAuthError(`${label} auth failed with status ${status}`);
  if (status === 429) {
    return new ProviderRateLimitError(`${label} rate limited`, parseRetryAfter(response.headers.get('retry-after')));
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new ProviderRequestError(`${label} refused the request with status ${status}`);
  }
  return new ProviderUnavailableError(`${label} returned status ${status}`);
}

export interface ProviderFailure {
  code: string;
  message: string;
}

/**
 * Turns a failed agent turn into something a person can act on. The raw provider
 * message stays out of the UI: it names an HTTP status, not a next step.
 */
export function describeAgentFailure(error: unknown, agentName: string): ProviderFailure {
  if (error instanceof ProviderAuthError) {
    return {
      code: 'provider_auth_failed',
      message: `${agentName} could not reply: the model provider rejected its API key. Update the key in Settings → Providers.`,
    };
  }
  if (error instanceof ProviderRateLimitError) {
    return {
      code: 'provider_rate_limited',
      message: `${agentName} could not reply: the model provider is rate limiting requests. Try again in a moment.`,
    };
  }
  if (error instanceof ProviderRequestError) {
    return {
      code: 'provider_bad_request',
      message: `${agentName} could not reply: the model provider refused the request. Check that the agent's model exists for this provider.`,
    };
  }
  if (error instanceof ProviderNotConfiguredError) {
    return {
      code: 'provider_not_configured',
      message: `${agentName} could not reply: no model provider is configured for it. Add one in Settings → Providers.`,
    };
  }
  if (error instanceof ProviderUnavailableError) {
    return {
      code: 'provider_unavailable',
      message: `${agentName} could not reply: the model provider could not be reached. Check the provider settings and your connection.`,
    };
  }
  if (error instanceof ProviderError) {
    return { code: error.code, message: `${agentName} could not reply: ${error.message}.` };
  }
  return { code: 'agent_run_failed', message: `${agentName} could not reply because of an unexpected error.` };
}
