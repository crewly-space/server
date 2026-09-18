import type { ChatRequest, ChatResponse, ModelInfo, ProviderKind } from '../protocol/index.js';
import type { ProviderClient } from './client.js';
import { ProviderAuthError, ProviderRateLimitError, ProviderUnavailableError } from './errors.js';

interface OpenAiChatResponseBody {
  choices: { message: { content: string }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAiModelsResponseBody {
  data: { id: string }[];
}

export class OpenAICompatibleClient implements ProviderClient {
  constructor(
    public readonly kind: ProviderKind,
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        }),
      });
    } catch (err) {
      throw new ProviderUnavailableError(`${this.kind} request failed: ${(err as Error).message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(`${this.kind} auth failed with status ${response.status}`);
    }
    if (response.status === 429) {
      throw new ProviderRateLimitError(`${this.kind} rate limited`);
    }
    if (!response.ok) {
      throw new ProviderUnavailableError(`${this.kind} returned status ${response.status}`);
    }

    const data = (await response.json()) as OpenAiChatResponseBody;
    if (!data.choices || data.choices.length === 0) {
      throw new ProviderUnavailableError(`${this.kind} returned no choices`);
    }
    const choice = data.choices[0];
    return {
      providerId: request.providerId,
      model: request.model,
      content: choice.message.content,
      stopReason: choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason === 'length' ? 'max_tokens' : 'error',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (err) {
      throw new ProviderUnavailableError(`${this.kind} models request failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new ProviderUnavailableError(`${this.kind} returned status ${response.status}`);
    }
    const data = (await response.json()) as OpenAiModelsResponseBody;
    return data.data.map((m) => ({ id: m.id, providerId: this.kind, displayName: m.id, contextWindow: 4096 }));
  }
}
