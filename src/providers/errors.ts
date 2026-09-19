export class ProviderError extends Error {}
export class ProviderUnavailableError extends ProviderError {}
export class ProviderAuthError extends ProviderError {}
export class ProviderRateLimitError extends ProviderError {}

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
  if (error instanceof ProviderUnavailableError) {
    return {
      code: 'provider_unavailable',
      message: `${agentName} could not reply: the model provider could not be reached. Check the provider settings and your connection.`,
    };
  }
  if (error instanceof ProviderError) {
    return { code: 'provider_error', message: `${agentName} could not reply: ${error.message}` };
  }
  return { code: 'agent_run_failed', message: `${agentName} could not reply because of an unexpected error.` };
}
