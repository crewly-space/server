export class CrewlyApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'CrewlyApiError';
  }
}

/** Error codes the server returns without a `message` of their own. */
const CODE_MESSAGES: Record<string, string> = {
  invalid_claim_token: 'That claim token is not valid. Copy it from the claim-token file in the server data directory.',
  setup_already_complete: 'This server already has an owner. Sign in instead.',
  invalid_credentials: 'That email and password do not match an account.',
  provider_not_configured: 'No model provider is configured for that agent. Add one in Settings, then try again.',
  provider_exists: 'A provider with that id already exists. Pick a different id.',
  forbidden: 'Your account is not allowed to do that.',
  not_a_participant: 'You are not a member of that conversation.',
  agent_not_found: 'That agent no longer exists.',
  conversation_not_found: 'That conversation no longer exists.',
  invalid_reply: 'That reply points at a message in another conversation.',
  invalid_request: 'Some of those details are not valid. Check the form and try again.',
  network_error: 'Cannot reach the Crewly server. Check that it is running.',
};

/** A sentence a person can act on, for a failure the server did not explain. */
export function describeStatus(status: number, code?: string): string {
  const known = code ? CODE_MESSAGES[code] : undefined;
  if (known) return known;
  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 403) return 'Your account is not allowed to do that.';
  if (status === 404) return 'That item no longer exists.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return 'The Crewly server hit an error. Check its logs for details.';
  return code ? `The request failed (${code}).` : 'The request failed.';
}
