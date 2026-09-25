import { HttpClient } from './http-client.js';
import { AgentsResource } from './resources/agents.js';
import { ApprovalsResource } from './resources/approvals.js';
import { AuthResource } from './resources/auth.js';
import { ConversationsResource } from './resources/conversations.js';
import { ChannelsResource } from './resources/channels.js';
import { HealthResource } from './resources/health.js';
import { MemoryResource } from './resources/memory.js';
import { MessagesResource } from './resources/messages.js';
import { ProvidersResource } from './resources/providers.js';
import { RuntimeResource } from './resources/runtime.js';
import { WsClient, type WebSocketConstructor } from './ws-client.js';
import { UsersResource } from './resources/users.js';
import { DevicesResource } from './resources/devices.js';
import { ServerResource } from './resources/server.js';
import { UsageResource } from './resources/usage.js';
import { RunsResource } from './resources/runs.js';
import { SecretsResource } from './resources/secrets.js';
import { McpResource } from './resources/mcp.js';
import { SkillsResource } from './resources/skills.js';
import { CrewlyResource } from './resources/crewly.js';
import { MailResource } from './resources/mail.js';
import { NotificationsResource } from './resources/notifications.js';
import { ConnectorsResource } from './resources/connectors.js';
import { AttachmentsResource } from './resources/attachments.js';
import { RolesResource } from './resources/roles.js';

export class CrewlyClient {
  private readonly http: HttpClient;
  private readonly baseUrl: string;

  readonly auth: AuthResource;
  readonly agents: AgentsResource;
  readonly conversations: ConversationsResource;
  readonly channels: ChannelsResource;
  readonly health: HealthResource;
  readonly messages: MessagesResource;
  readonly memory: MemoryResource;
  readonly providers: ProvidersResource;
  readonly runtime: RuntimeResource;
  readonly approvals: ApprovalsResource;
  readonly users: UsersResource;
  readonly devices: DevicesResource;
  readonly server: ServerResource;
  readonly usage: UsageResource;
  readonly runs: RunsResource;
  readonly secrets: SecretsResource;
  readonly mcp: McpResource;
  readonly skills: SkillsResource;
  readonly crewly: CrewlyResource;
  readonly mail: MailResource;
  readonly notifications: NotificationsResource;
  readonly connectors: ConnectorsResource;
  readonly attachments: AttachmentsResource;
  readonly roles: RolesResource;

  constructor(opts: { baseUrl: string; fetchImpl?: typeof fetch; clientVersion?: string }) {
    this.baseUrl = opts.baseUrl;
    this.http = new HttpClient(opts.baseUrl, opts.fetchImpl, opts.clientVersion);
    this.auth = new AuthResource(this.http);
    this.agents = new AgentsResource(this.http);
    this.conversations = new ConversationsResource(this.http);
    this.channels = new ChannelsResource(this.http);
    this.health = new HealthResource(this.http);
    this.messages = new MessagesResource(this.http);
    this.memory = new MemoryResource(this.http);
    this.providers = new ProvidersResource(this.http);
    this.runtime = new RuntimeResource(this.http);
    this.approvals = new ApprovalsResource(this.http);
    this.users = new UsersResource(this.http);
    this.devices = new DevicesResource(this.http);
    this.server = new ServerResource(this.http);
    this.usage = new UsageResource(this.http);
    this.runs = new RunsResource(this.http);
    this.secrets = new SecretsResource(this.http);
    this.mcp = new McpResource(this.http);
    this.skills = new SkillsResource(this.http);
    this.crewly = new CrewlyResource(this.http);
    this.mail = new MailResource(this.http);
    this.notifications = new NotificationsResource(this.http);
    this.connectors = new ConnectorsResource(this.http);
    this.attachments = new AttachmentsResource(this.http);
    this.roles = new RolesResource(this.http);
  }

  setToken(token: string | undefined): void {
    this.http.setToken(token);
  }

  ws(WebSocketImpl: WebSocketConstructor): WsClient {
    return new WsClient(this.baseUrl, WebSocketImpl);
  }
}
