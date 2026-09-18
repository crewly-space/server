import type { ChatRequest, ChatResponse, ModelInfo } from '../protocol/index.js';
import type { ProviderClient } from './client.js';
import { ProviderAuthError, ProviderRateLimitError, ProviderUnavailableError } from './errors.js';

interface AnthropicChatResponseBody {
  content: { type: string; text?: string }[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicClient implements ProviderClient {
  readonly kind = 'anthropic' as const;

  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
    private baseUrl = 'https://api.anthropic.com'
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxTokens ?? 1024,
          system: system || undefined,
          messages,
        }),
      });
    } catch (err) {
      throw new ProviderUnavailableError(`anthropic request failed: ${(err as Error).message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(`anthropic auth failed with status ${response.status}`);
    }
    if (response.status === 429) {
      throw new ProviderRateLimitError('anthropic rate limited');
    }
    if (!response.ok) {
      throw new ProviderUnavailableError(`anthropic returned status ${response.status}`);
    }

    const data = (await response.json()) as AnthropicChatResponseBody;
    const text = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      providerId: request.providerId,
      model: request.model,
      content: text,
      stopReason: data.stop_reason === 'end_turn' ? 'end_turn' : data.stop_reason === 'max_tokens' ? 'max_tokens' : 'error',
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'claude-sonnet-5', providerId: 'anthropic', displayName: 'Claude Sonnet 5', contextWindow: 200000 },
      { id: 'claude-opus-5', providerId: 'anthropic', displayName: 'Claude Opus 5', contextWindow: 200000 },
      { id: 'claude-haiku-4-5', providerId: 'anthropic', displayName: 'Claude Haiku 4.5', contextWindow: 200000 },
    ];
  }
}
