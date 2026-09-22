import type { ChatMessage, ChatRequest, ModelInfo, ProviderKind, ToolCall } from '../protocol/index.js';
import { readRateLimitHeaders, type ProviderChatResult, type ProviderClient } from './client.js';
import { errorForStatus, ProviderUnavailableError } from './errors.js';

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiChatResponseBody {
  choices: { message: { content: string | null; tool_calls?: OpenAiToolCall[] }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAiModelsResponseBody {
  data: { id: string }[];
}

export function toOpenAiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

/** A model that writes broken JSON for its arguments still gets its call; the tool decides. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class OpenAICompatibleClient implements ProviderClient {
  constructor(
    public readonly kind: ProviderKind,
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  async chat(request: ChatRequest): Promise<ProviderChatResult> {
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
          messages: toOpenAiMessages(request.messages),
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          tools: request.tools?.length
            ? request.tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
              }))
            : undefined,
        }),
      });
    } catch (err) {
      throw new ProviderUnavailableError(`${this.kind} request failed: ${(err as Error).message}`);
    }

    if (!response.ok) throw errorForStatus(this.kind, response);

    const data = (await response.json()) as OpenAiChatResponseBody;
    if (!data.choices || data.choices.length === 0) {
      throw new ProviderUnavailableError(`${this.kind} returned no choices`);
    }
    const choice = data.choices[0]!;
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    }));
    const stopReason = choice.finish_reason === 'stop' ? 'end_turn'
      : choice.finish_reason === 'length' ? 'max_tokens'
      : choice.finish_reason === 'tool_calls' || toolCalls.length > 0 ? 'tool_use'
      : 'error';
    return {
      providerId: request.providerId,
      model: request.model,
      content: choice.message.content ?? '',
      stopReason,
      ...(toolCalls.length ? { toolCalls } : {}),
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      rateLimit: readRateLimitHeaders(response.headers),
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
    if (!response.ok) throw errorForStatus(this.kind, response);
    const data = (await response.json()) as OpenAiModelsResponseBody;
    return data.data.map((m) => ({ id: m.id, providerId: this.kind, displayName: m.id, contextWindow: 4096 }));
  }
}
