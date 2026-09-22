import type { ChatMessage, ChatRequest, ModelInfo, ToolCall } from '../protocol/index.js';
import { readRateLimitHeaders, type ProviderChatResult, type ProviderClient } from './client.js';
import { errorForStatus, ProviderUnavailableError } from './errors.js';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

interface AnthropicChatResponseBody {
  content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Crewly's turns as Anthropic's: tool calls become `tool_use` blocks on the
 * assistant turn, and each run of tool results becomes one user turn of
 * `tool_result` blocks, which is the only place Anthropic accepts them.
 */
export function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      };
      const previous = out[out.length - 1];
      if (previous?.role === 'user' && Array.isArray(previous.content)
        && previous.content.every((b) => b.type === 'tool_result')) {
        previous.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const blocks: AnthropicBlock[] = message.content ? [{ type: 'text', text: message.content }] : [];
      for (const call of message.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

export class AnthropicClient implements ProviderClient {
  readonly kind = 'anthropic' as const;

  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
    private baseUrl = 'https://api.anthropic.com'
  ) {}

  async chat(request: ChatRequest): Promise<ProviderChatResult> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

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
          messages: toAnthropicMessages(request.messages),
          tools: request.tools?.length
            ? request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              }))
            : undefined,
        }),
      });
    } catch (err) {
      throw new ProviderUnavailableError(`anthropic request failed: ${(err as Error).message}`);
    }

    if (!response.ok) throw errorForStatus('anthropic', response);

    const data = (await response.json()) as AnthropicChatResponseBody;
    const text = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const toolCalls: ToolCall[] = data.content
      .filter((block) => block.type === 'tool_use' && block.id && block.name)
      .map((block) => ({ id: block.id!, name: block.name!, input: block.input ?? {} }));

    const stopReason = data.stop_reason === 'end_turn' ? 'end_turn'
      : data.stop_reason === 'max_tokens' ? 'max_tokens'
      : data.stop_reason === 'tool_use' ? 'tool_use'
      : 'error';
    return {
      providerId: request.providerId,
      model: request.model,
      content: text,
      stopReason,
      ...(toolCalls.length ? { toolCalls } : {}),
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
      rateLimit: readRateLimitHeaders(response.headers),
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
