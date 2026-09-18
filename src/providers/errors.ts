export class ProviderError extends Error {}
export class ProviderUnavailableError extends ProviderError {}
export class ProviderAuthError extends ProviderError {}
export class ProviderRateLimitError extends ProviderError {}
