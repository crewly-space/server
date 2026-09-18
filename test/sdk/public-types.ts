import type {
  AddConversationMemberInput,
  AuthLoginInput,
  AuthResource,
  AuthSetupInput,
  ConversationsResource,
  CreateDmInput,
  CreateGroupInput,
  CreateMemoryFactInput,
  CreateProviderInput,
  CreateRuntimeBindingInput,
  CreateRuntimeSessionInput,
  InvokeAgentInput,
  MemoryResource,
  MessagesResource,
  ProvidersResource,
  RuntimeResource,
  SendMessageInput,
  UpdateMemoryFactInput,
  WebSocketConstructor,
} from '../../src/sdk/index.js';
import WebSocket from 'ws';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

export type PublicRequestInputContract = [
  Assert<Equal<Parameters<AuthResource['setup']>[0], AuthSetupInput>>,
  Assert<Equal<Parameters<AuthResource['login']>[0], AuthLoginInput>>,
  Assert<Equal<Parameters<ConversationsResource['createDm']>[0], CreateDmInput>>,
  Assert<Equal<Parameters<ConversationsResource['createGroup']>[0], CreateGroupInput>>,
  Assert<Equal<Parameters<ConversationsResource['addMember']>[1], AddConversationMemberInput>>,
  Assert<Equal<Parameters<MessagesResource['send']>[1], SendMessageInput>>,
  Assert<Equal<Parameters<MemoryResource['createFact']>[1], CreateMemoryFactInput>>,
  Assert<Equal<Parameters<MemoryResource['updateFact']>[2], UpdateMemoryFactInput>>,
  Assert<Equal<Parameters<ProvidersResource['create']>[0], CreateProviderInput>>,
  Assert<Equal<Parameters<RuntimeResource['createBinding']>[0], CreateRuntimeBindingInput>>,
  Assert<Equal<Parameters<RuntimeResource['createSession']>[0], CreateRuntimeSessionInput>>,
  Assert<Equal<Parameters<RuntimeResource['invokeAgent']>[1], InvokeAgentInput>>,
];

type InvalidWebSocketConstructor = new (url: string) => { url: string };

export type WebSocketConstructorContract = [
  Assert<Equal<typeof globalThis.WebSocket extends WebSocketConstructor ? true : false, true>>,
  Assert<Equal<typeof WebSocket extends WebSocketConstructor ? true : false, true>>,
  Assert<Equal<InvalidWebSocketConstructor extends WebSocketConstructor ? true : false, false>>,
];
