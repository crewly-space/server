import type { ChatRequest, ChatResponse, ModelInfo, ProviderKind } from '../protocol/index.js';

export interface ProviderClient {
  readonly kind: ProviderKind;
  chat(request: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<ModelInfo[]>;
}
