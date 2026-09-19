import { HttpClient } from './http-client.js';
import { AgentsResource } from './resources/agents.js';
import { ApprovalsResource } from './resources/approvals.js';
import { AuthResource } from './resources/auth.js';
import { ConversationsResource } from './resources/conversations.js';
import { HealthResource } from './resources/health.js';
import { MemoryResource } from './resources/memory.js';
import { MessagesResource } from './resources/messages.js';
import { ProvidersResource } from './resources/providers.js';
import { RuntimeResource } from './resources/runtime.js';
import { WsClient, type WebSocketConstructor } from './ws-client.js';
import { UsersResource } from './resources/users.js';
import { DevicesResource } from './resources/devices.js';

export class CrewlyClient {
  private readonly http: HttpClient;
  private readonly baseUrl: string;

  readonly auth: AuthResource;
  readonly agents: AgentsResource;
  readonly conversations: ConversationsResource;
  readonly health: HealthResource;
  readonly messages: MessagesResource;
  readonly memory: MemoryResource;
  readonly providers: ProvidersResource;
  readonly runtime: RuntimeResource;
  readonly approvals: ApprovalsResource;
  readonly users: UsersResource;
  readonly devices: DevicesResource;

  constructor(opts: { baseUrl: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl;
    this.http = new HttpClient(opts.baseUrl, opts.fetchImpl);
    this.auth = new AuthResource(this.http);
    this.agents = new AgentsResource(this.http);
    this.conversations = new ConversationsResource(this.http);
    this.health = new HealthResource(this.http);
    this.messages = new MessagesResource(this.http);
    this.memory = new MemoryResource(this.http);
    this.providers = new ProvidersResource(this.http);
    this.runtime = new RuntimeResource(this.http);
    this.approvals = new ApprovalsResource(this.http);
    this.users = new UsersResource(this.http);
    this.devices = new DevicesResource(this.http);
  }

  setToken(token: string | undefined): void {
    this.http.setToken(token);
  }

  ws(WebSocketImpl: WebSocketConstructor): WsClient {
    return new WsClient(this.baseUrl, WebSocketImpl);
  }
}
