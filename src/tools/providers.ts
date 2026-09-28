import type { AuthType, ProviderCategory, ToolPolicyMode, ToolRisk } from './types.js';

/**
 * Provider profiles: what Crewly knows about a service independent of how it
 * is connected. A profile never contains provider logic an agent depends on;
 * it only lets tools from any connection to that provider be classified the
 * same way, and lets skills ask for a capability ("error_tracking") rather
 * than a vendor ("sentry").
 *
 * A provider can have many connections: a native OAuth connector, the
 * vendor's official MCP server, a company's own MCP server -- and more than
 * one account of each.
 */

export interface ToolRule {
  /** Matched against the normalized snake_case tool name. */
  match: RegExp;
  permission?: string;
  risk?: ToolRisk;
}

export interface ProviderIntegration {
  kind: 'native' | 'mcp' | 'api';
  label: string;
  /** For remote MCP: its endpoint. */
  url?: string;
  auth: AuthType;
  official: boolean;
}

export interface ProviderProfile {
  id: string;
  name: string;
  category: ProviderCategory;
  /** Capability areas: what a skill can ask for instead of naming this vendor. */
  areas: string[];
  /** Hostnames that identify one of its MCP servers when nobody said which provider it is. */
  hosts?: string[];
  integrations: ProviderIntegration[];
  /** Tool-name rules, checked before the generic classifier. First match wins. */
  rules?: ToolRule[];
  /** Resource words this provider uses for a shared resource: Sentry's "issue" is an error. */
  resourceAliases?: Record<string, string>;
  /** Stricter defaults for permissions on this provider, e.g. payouts blocked. */
  defaultModes?: Record<string, ToolPolicyMode>;
  /** Very large tool surfaces are offered through tool search rather than all at once. */
  large?: boolean;
  priority?: 'P0' | 'P1' | 'P2';
}

const mcp = (url: string, auth: AuthType = 'mcp_oauth', label = 'Official MCP'): ProviderIntegration =>
  ({ kind: 'mcp', label, url, auth, official: true });
const native = (auth: AuthType = 'oauth2'): ProviderIntegration => ({ kind: 'native', label: 'Crewly connector', auth, official: true });
const api = (auth: AuthType = 'api_key'): ProviderIntegration => ({ kind: 'api', label: 'API', auth, official: true });

/** Repository resources all read the same: a file, a tree, a commit are all the repository. */
const REPO_ALIASES: Record<string, string> = {
  file: 'repo', file_content: 'repo', file_contents: 'repo', content: 'repo', contents: 'repo', repository: 'repo',
  tree: 'repo', code: 'repo', blob: 'repo', ref: 'repo', tag: 'repo', repository_tree: 'repo',
  // Reading history is reading the repository; creating commits and branches has its own rules above.
  commit: 'repo', commits: 'repo', branch: 'repo', branches: 'repo',
  pr: 'pull_request', merge_request: 'pull_request', mr: 'pull_request', pull_request_review: 'review',
  workflow_run: 'actions', workflow: 'actions', job: 'actions', job_log: 'actions', action: 'actions', check_run: 'actions',
};

const GIT_RULES: ToolRule[] = [
  { match: /^merge_(pull_request|merge_request|pr)$/, permission: 'pull_request:merge', risk: 'deploy' },
  { match: /^(create|update)_(or_update_)?file|^push_files$|^create_or_update_file$|^delete_file$/, permission: 'commit:create', risk: 'write' },
  { match: /^create_branch$/, permission: 'branch:create', risk: 'write' },
  { match: /^(create|update)_(pull_request|merge_request)$/, permission: 'pull_request:create', risk: 'write' },
  { match: /^delete_(repository|repo|project)$/, permission: 'repo:delete', risk: 'dangerous' },
  { match: /^(create|update)_(repository|repo)$|^fork_repository$/, permission: 'repo:admin', risk: 'admin' },
  { match: /(collaborator|team_member|permission|branch_protection|secret)s?$/, risk: 'admin' },
  { match: /^(run|trigger|rerun|cancel)_(workflow|job|pipeline)|^actions_run_trigger$/, permission: 'actions:execute', risk: 'execute' },
  { match: /^(create|publish)_release$/, permission: 'release:create', risk: 'deploy' },
];

export const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  // Development
  { id: 'github', name: 'GitHub', category: 'development', areas: ['code_host', 'issue_tracker', 'ci'], priority: 'P0',
    hosts: ['api.githubcopilot.com'], integrations: [native(), { ...native('github_app'), label: 'GitHub App' }, mcp('https://api.githubcopilot.com/mcp/', 'mcp_token')],
    rules: GIT_RULES, resourceAliases: REPO_ALIASES, large: true },
  { id: 'gitlab', name: 'GitLab', category: 'development', areas: ['code_host', 'issue_tracker', 'ci'], priority: 'P0',
    hosts: ['gitlab.com'], integrations: [native(), mcp('https://gitlab.com/api/v4/mcp')], rules: GIT_RULES, resourceAliases: REPO_ALIASES },
  { id: 'bitbucket', name: 'Bitbucket', category: 'development', areas: ['code_host'], integrations: [api('oauth2')], rules: GIT_RULES, resourceAliases: REPO_ALIASES },
  { id: 'azure-devops', name: 'Azure DevOps', category: 'development', areas: ['code_host', 'issue_tracker', 'ci'], integrations: [api('bearer_token')], rules: GIT_RULES, resourceAliases: REPO_ALIASES },
  { id: 'sourcegraph', name: 'Sourcegraph', category: 'development', areas: ['code_search'], integrations: [api('bearer_token')] },
  { id: 'git', name: 'Git', category: 'development', areas: ['code_host'], integrations: [{ kind: 'mcp', label: 'Reference MCP (local)', auth: 'none', official: true }], rules: GIT_RULES, resourceAliases: REPO_ALIASES, priority: 'P0' },
  { id: 'filesystem', name: 'Filesystem', category: 'development', areas: ['files'], integrations: [{ kind: 'mcp', label: 'Reference MCP (local)', auth: 'none', official: true }], priority: 'P0',
    rules: [{ match: /^(write|edit|create|move)_/, risk: 'write' }, { match: /^delete_/, risk: 'delete' }] },
  { id: 'npm', name: 'npm', category: 'development', areas: ['package_registry'], integrations: [api('none')] },
  { id: 'pypi', name: 'PyPI', category: 'development', areas: ['package_registry'], integrations: [api('none')] },
  { id: 'docker-hub', name: 'Docker Hub', category: 'development', areas: ['container_registry'], integrations: [api('bearer_token')] },
  { id: 'hugging-face', name: 'Hugging Face', category: 'ai', areas: ['model_hub'], hosts: ['huggingface.co'], integrations: [mcp('https://huggingface.co/mcp', 'mcp_token')] },

  // Deployment and cloud
  { id: 'vercel', name: 'Vercel', category: 'cloud', areas: ['deployment', 'hosting'], priority: 'P0', hosts: ['mcp.vercel.com'],
    integrations: [mcp('https://mcp.vercel.com')],
    rules: [
      { match: /promote|production|rollback/, permission: 'deployment:production', risk: 'deploy' },
      { match: /^deploy/, permission: 'deployment:preview', risk: 'write' },
      { match: /^(get|list)_deployment_(build_)?logs?|_logs?$/, permission: 'logs:read', risk: 'read' },
      { match: /(env|environment_variable)s?$/, risk: 'admin' },
    ] },
  { id: 'cloudflare', name: 'Cloudflare', category: 'cloud', areas: ['dns', 'hosting', 'deployment', 'cdn', 'security'], priority: 'P0', large: true,
    hosts: ['mcp.cloudflare.com', 'observability.mcp.cloudflare.com', 'docs.mcp.cloudflare.com', 'radar.mcp.cloudflare.com', 'browser.mcp.cloudflare.com', 'bindings.mcp.cloudflare.com', 'builds.mcp.cloudflare.com'],
    integrations: [mcp('https://mcp.cloudflare.com/mcp', 'mcp_token', 'Official MCP (Code Mode)')],
    rules: [
      // Cloudflare's code-mode server runs arbitrary API calls through one tool.
      { match: /^execute$/, permission: 'cloudflare_api:execute', risk: 'execute' },
      { match: /^search$/, permission: 'cloudflare_api:read', risk: 'read' },
      { match: /dns_record/, permission: 'dns:write' },
      { match: /^(deploy|publish)_/, permission: 'deployment:production', risk: 'deploy' },
    ] },
  { id: 'netlify', name: 'Netlify', category: 'cloud', areas: ['deployment', 'hosting'], hosts: ['netlify-mcp.netlify.app'], integrations: [mcp('https://netlify-mcp.netlify.app/mcp')],
    rules: [{ match: /deploy/, permission: 'deployment:preview', risk: 'write' }] },
  { id: 'railway', name: 'Railway', category: 'cloud', areas: ['deployment', 'hosting'], integrations: [api('bearer_token')] },
  { id: 'render', name: 'Render', category: 'cloud', areas: ['deployment', 'hosting'], integrations: [api('api_key')] },
  { id: 'fly', name: 'Fly.io', category: 'cloud', areas: ['deployment', 'hosting'], integrations: [api('bearer_token'), { kind: 'api', label: 'flyctl', auth: 'cli', official: true }] },
  { id: 'digitalocean', name: 'DigitalOcean', category: 'cloud', areas: ['hosting', 'compute'], integrations: [api('bearer_token')] },
  { id: 'aws', name: 'AWS', category: 'cloud', areas: ['compute', 'storage', 'hosting', 'cloud_cost'], large: true, integrations: [api('service_account')] },
  { id: 'gcp', name: 'Google Cloud', category: 'cloud', areas: ['compute', 'storage', 'hosting', 'cloud_cost'], large: true, integrations: [api('service_account')] },
  { id: 'azure', name: 'Azure', category: 'cloud', areas: ['compute', 'storage', 'hosting', 'cloud_cost'], large: true, integrations: [api('service_account')] },
  { id: 'kubernetes', name: 'Kubernetes', category: 'cloud', areas: ['compute'], integrations: [{ kind: 'mcp', label: 'MCP (local)', auth: 'custom_headers', official: false }],
    rules: [{ match: /^(apply|scale|rollout|restart)/, risk: 'deploy' }, { match: /^delete_/, risk: 'dangerous' }] },
  { id: 'terraform-cloud', name: 'Terraform Cloud', category: 'cloud', areas: ['infrastructure'], integrations: [api('bearer_token')], rules: [{ match: /apply/, risk: 'deploy' }] },

  // Databases: read-only by default, and destructive statements always ask.
  ...(['postgres', 'mysql', 'sqlite', 'clickhouse', 'snowflake', 'bigquery'] as const).map((id): ProviderProfile => ({
    id, name: { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', clickhouse: 'ClickHouse', snowflake: 'Snowflake', bigquery: 'BigQuery' }[id],
    category: 'databases', areas: ['database'], priority: id === 'postgres' ? 'P0' : undefined,
    integrations: [{ kind: 'mcp', label: 'MCP', auth: 'custom_headers', official: id !== 'mysql' }],
    rules: [
      { match: /^(list|describe|get)_(schemas?|tables?|columns?|indexes?)/, permission: 'schema:read', risk: 'read' },
      { match: /^(query|select|read_query|run_select)/, permission: 'data:read', risk: 'read' },
      { match: /^(execute|run|write_query|exec)(_sql|_query)?$|^(execute|run)_sql$/, permission: 'query:execute', risk: 'execute' },
      { match: /migrat|alter|create_table/, permission: 'schema:write', risk: 'dangerous' },
    ],
  })),
  { id: 'supabase', name: 'Supabase', category: 'databases', areas: ['database', 'auth', 'hosting'], hosts: ['mcp.supabase.com'], integrations: [mcp('https://mcp.supabase.com/mcp', 'mcp_token')],
    rules: [{ match: /^execute_sql$/, permission: 'query:execute', risk: 'execute' }, { match: /^apply_migration$/, permission: 'schema:write', risk: 'dangerous' },
      { match: /^(delete|pause)_project$/, risk: 'dangerous' }, { match: /^deploy_edge_function$/, permission: 'deployment:production', risk: 'deploy' }] },
  { id: 'neon', name: 'Neon', category: 'databases', areas: ['database'], hosts: ['mcp.neon.tech'], integrations: [mcp('https://mcp.neon.tech/mcp', 'mcp_token')],
    rules: [{ match: /^run_sql/, permission: 'query:execute', risk: 'execute' }, { match: /migration/, permission: 'schema:write', risk: 'dangerous' }, { match: /^delete_project$/, risk: 'dangerous' }] },
  { id: 'planetscale', name: 'PlanetScale', category: 'databases', areas: ['database'], integrations: [api('service_account')] },
  { id: 'mongodb-atlas', name: 'MongoDB Atlas', category: 'databases', areas: ['database'], integrations: [api('api_key')] },
  { id: 'redis', name: 'Redis', category: 'databases', areas: ['cache'], integrations: [api('basic')] },
  { id: 'upstash', name: 'Upstash', category: 'databases', areas: ['cache', 'database'], integrations: [api('bearer_token')] },
  { id: 'turso', name: 'Turso', category: 'databases', areas: ['database'], integrations: [api('bearer_token')] },

  // Monitoring
  { id: 'sentry', name: 'Sentry', category: 'monitoring', areas: ['error_tracking', 'performance'], priority: 'P0', hosts: ['mcp.sentry.dev'],
    integrations: [mcp('https://mcp.sentry.dev/mcp')],
    resourceAliases: { issue: 'errors', issues: 'errors', issue_detail: 'errors', issue_details: 'errors', event: 'errors', events: 'errors', event_attachment: 'errors', trace: 'traces', trace_detail: 'traces', trace_details: 'traces' },
    rules: [
      { match: /^(search|find|get|list)_(issues?|events?|issue_details|event_attachment)$|^analyze_issue/, permission: 'errors:read', risk: 'read' },
      { match: /^update_issue$/, permission: 'errors:write', risk: 'write' },
      { match: /^(find|get)_(releases?)$/, permission: 'release:read', risk: 'read' },
      { match: /^create_(project|team|dsn)$/, risk: 'admin' },
    ] },
  { id: 'datadog', name: 'Datadog', category: 'monitoring', areas: ['error_tracking', 'logs', 'metrics', 'performance'], integrations: [mcp('https://mcp.datadoghq.com/api/unstable/mcp-server/mcp')],
    resourceAliases: { issue: 'errors', error: 'errors', errors: 'errors', log: 'logs' } },
  { id: 'new-relic', name: 'New Relic', category: 'monitoring', areas: ['error_tracking', 'metrics', 'performance'], integrations: [api('api_key')], resourceAliases: { error: 'errors', errors_inbox: 'errors' } },
  { id: 'grafana', name: 'Grafana', category: 'monitoring', areas: ['metrics', 'logs'], integrations: [{ kind: 'mcp', label: 'Official MCP', auth: 'bearer_token', official: true }] },
  { id: 'better-stack', name: 'Better Stack', category: 'monitoring', areas: ['logs', 'uptime', 'incidents'], integrations: [api('bearer_token')] },
  { id: 'axiom', name: 'Axiom', category: 'monitoring', areas: ['logs'], integrations: [mcp('https://mcp.axiom.co/mcp')] },
  { id: 'honeycomb', name: 'Honeycomb', category: 'monitoring', areas: ['performance', 'traces'], integrations: [api('api_key')] },
  { id: 'pagerduty', name: 'PagerDuty', category: 'monitoring', areas: ['incidents', 'on_call'], integrations: [api('bearer_token')],
    rules: [{ match: /^(acknowledge|resolve|escalate)_/, permission: 'incident:write', risk: 'write' }] },
  { id: 'opsgenie', name: 'Opsgenie', category: 'monitoring', areas: ['incidents', 'on_call'], integrations: [api('api_key')] },
  { id: 'statuspage', name: 'Statuspage', category: 'monitoring', areas: ['status_page'], integrations: [api('api_key')], rules: [{ match: /^(create|update)_incident/, risk: 'external_message' }] },

  // Payments and finance: money moves only with a person in the loop.
  { id: 'stripe', name: 'Stripe', category: 'finance', areas: ['payments', 'billing'], priority: 'P0', hosts: ['mcp.stripe.com'],
    integrations: [mcp('https://mcp.stripe.com', 'mcp_token')],
    rules: [
      { match: /payout/, permission: 'payout:create', risk: 'financial' },
      { match: /^create_refund|refund/, permission: 'refund:create', risk: 'financial' },
      { match: /transfer/, permission: 'transfer:create', risk: 'financial' },
      { match: /^(create|finalize|send)_invoice/, permission: 'invoice:create', risk: 'financial' },
      { match: /^(cancel|update)_subscription/, permission: 'subscription:write', risk: 'financial' },
      { match: /^create_(payment_link|price|product|coupon|customer)/, risk: 'write' },
      { match: /^(retrieve|get)_balance/, permission: 'balance:read', risk: 'read' },
    ],
    defaultModes: { 'payout:create': 'blocked', 'transfer:create': 'ask_every_time', 'refund:create': 'ask_every_time', 'invoice:create': 'ask_every_time' } },
  ...([['paddle', 'Paddle'], ['lemon-squeezy', 'Lemon Squeezy'], ['chargebee', 'Chargebee'], ['paypal', 'PayPal'], ['adyen', 'Adyen'], ['square', 'Square'], ['gocardless', 'GoCardless']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'finance', areas: ['payments', 'billing'], integrations: [api()],
      hosts: id === 'paypal' ? ['mcp.paypal.com', 'mcp.sandbox.paypal.com'] : id === 'square' ? ['mcp.squareup.com'] : undefined,
      rules: [{ match: /payout/, permission: 'payout:create', risk: 'financial' }, { match: /refund/, permission: 'refund:create', risk: 'financial' }, { match: /transfer/, permission: 'transfer:create', risk: 'financial' }, { match: /invoice/, permission: 'invoice:create', risk: 'financial' }],
      defaultModes: { 'payout:create': 'blocked' } })),
  ...([['plaid', 'Plaid'], ['wise', 'Wise Business'], ['revolut', 'Revolut Business'], ['mercury', 'Mercury'], ['brex', 'Brex'], ['ramp', 'Ramp']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'finance', areas: ['banking'], integrations: [api('oauth2')], hosts: id === 'mercury' ? ['mcp.mercury.com'] : undefined,
      rules: [{ match: /transfer|payment|payout|send/, permission: 'transfer:create', risk: 'financial' }], defaultModes: { 'transfer:create': 'blocked', 'payout:create': 'blocked' } })),
  ...([['quickbooks', 'QuickBooks'], ['xero', 'Xero'], ['freshbooks', 'FreshBooks'], ['sage', 'Sage']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'finance', areas: ['accounting'], integrations: [api('oauth2')],
      rules: [{ match: /^(create|update|void|delete)_(invoice|bill|payment|journal)/, risk: 'financial' }] })),

  // Analytics
  { id: 'posthog', name: 'PostHog', category: 'analytics', areas: ['product_analytics', 'feature_flags'], priority: 'P0', hosts: ['mcp.posthog.com'],
    integrations: [mcp('https://mcp.posthog.com/mcp', 'mcp_token')],
    rules: [{ match: /^(create|update|delete)_feature_flag/, permission: 'feature_flag:write', risk: 'deploy' }, { match: /query|insight|trends|funnel|retention/, permission: 'analytics:read', risk: 'read' }] },
  ...([['amplitude', 'Amplitude'], ['mixpanel', 'Mixpanel'], ['google-analytics', 'Google Analytics 4'], ['plausible', 'Plausible'], ['segment', 'Segment'], ['rudderstack', 'RudderStack'], ['heap', 'Heap']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'analytics', areas: ['product_analytics'], integrations: [api()] })),

  // CRM and sales
  ...([['hubspot', 'HubSpot', 'https://mcp.hubspot.com'], ['salesforce', 'Salesforce', undefined], ['pipedrive', 'Pipedrive', undefined], ['close', 'Close', undefined], ['apollo', 'Apollo', undefined], ['attio', 'Attio', 'https://mcp.attio.com/mcp'], ['zoho-crm', 'Zoho CRM', undefined]] as const)
    .map(([id, name, url]): ProviderProfile => ({ id, name, category: 'crm', areas: ['crm'], integrations: url ? [mcp(url)] : [api('oauth2')],
      rules: [{ match: /^send_|email/, risk: 'external_message' }] })),

  // Support
  ...([['intercom', 'Intercom', 'https://mcp.intercom.com/mcp'], ['zendesk', 'Zendesk', undefined], ['front', 'Front', undefined], ['help-scout', 'Help Scout', undefined], ['crisp', 'Crisp', undefined], ['freshdesk', 'Freshdesk', undefined], ['gorgias', 'Gorgias', undefined]] as const)
    .map(([id, name, url]): ProviderProfile => ({ id, name, category: 'support', areas: ['support_desk'], integrations: url ? [mcp(url)] : [api('oauth2')],
      resourceAliases: { conversation: 'ticket', conversations: 'ticket', tickets: 'ticket' },
      rules: [{ match: /^(reply|send|respond)_|reply_to|_reply$/, permission: 'ticket:reply', risk: 'external_message' }, { match: /^(create|add)_(note|internal_note)/, permission: 'ticket:note', risk: 'write' }] })),

  // Communication: drafting is a write, sending is an external message.
  { id: 'gmail', name: 'Gmail', category: 'communication', areas: ['email'], priority: 'P0', integrations: [native()],
    rules: [{ match: /^send_(email|message)|^send$/, permission: 'email:send', risk: 'external_message' }, { match: /draft/, permission: 'email:draft', risk: 'write' }, { match: /^(read|search|list|get)_/, permission: 'email:read', risk: 'read' }] },
  { id: 'outlook', name: 'Outlook', category: 'communication', areas: ['email'], integrations: [api('oauth2')],
    rules: [{ match: /^send_/, permission: 'email:send', risk: 'external_message' }, { match: /draft/, permission: 'email:draft', risk: 'write' }] },
  { id: 'google-calendar', name: 'Google Calendar', category: 'communication', areas: ['calendar'], priority: 'P0', integrations: [native()],
    resourceAliases: { event: 'calendar', events: 'calendar' }, rules: [{ match: /^(create|update)_event$/, permission: 'calendar:write', risk: 'external_message' }, { match: /^delete_event$/, permission: 'calendar:delete', risk: 'delete' }] },
  { id: 'microsoft-calendar', name: 'Microsoft Calendar', category: 'communication', areas: ['calendar'], integrations: [api('oauth2')] },
  { id: 'slack', name: 'Slack', category: 'communication', areas: ['chat'], integrations: [native()],
    rules: [{ match: /^(post|send)_messages?$|^chat_post|^send_/, permission: 'slack:send', risk: 'external_message' }, { match: /draft/, permission: 'slack:draft', risk: 'write' }, { match: /^(read|list|get|search)_/, permission: 'slack:read', risk: 'read' }] },
  ...([['microsoft-teams', 'Microsoft Teams'], ['discord', 'Discord'], ['telegram', 'Telegram'], ['whatsapp-business', 'WhatsApp Business'], ['twilio', 'Twilio']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'communication', areas: ['chat'], integrations: [api('bearer_token')], rules: [{ match: /^(send|post|reply)_/, risk: 'external_message' }] })),
  ...([['resend', 'Resend'], ['postmark', 'Postmark'], ['sendgrid', 'SendGrid'], ['mailgun', 'Mailgun']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'communication', areas: ['transactional_email'], integrations: [api()], rules: [{ match: /^send_|^send$/, permission: 'email:send', risk: 'external_message' }] })),

  // Documents and knowledge
  { id: 'notion', name: 'Notion', category: 'knowledge', areas: ['docs', 'wiki'], priority: 'P0', hosts: ['mcp.notion.com'],
    integrations: [native(), mcp('https://mcp.notion.com/mcp')], resourceAliases: { page: 'docs', pages: 'docs', database: 'docs', block: 'docs', comment: 'comment' } },
  { id: 'google-drive', name: 'Google Drive', category: 'knowledge', areas: ['files', 'docs'], priority: 'P0', integrations: [native()] },
  ...([['confluence', 'Confluence'], ['sharepoint', 'SharePoint'], ['onedrive', 'OneDrive'], ['dropbox', 'Dropbox'], ['box', 'Box'], ['airtable', 'Airtable'], ['coda', 'Coda']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'knowledge', areas: ['docs', 'files'], integrations: id === 'dropbox' ? [native()] : [api('oauth2')] })),

  // Project management
  { id: 'linear', name: 'Linear', category: 'project_management', areas: ['issue_tracker'], priority: 'P0', hosts: ['mcp.linear.app'],
    integrations: [native(), mcp('https://mcp.linear.app/mcp')] },
  { id: 'atlassian', name: 'Jira & Confluence', category: 'project_management', areas: ['issue_tracker', 'docs'], hosts: ['mcp.atlassian.com'], integrations: [mcp('https://mcp.atlassian.com/v1/sse')] },
  { id: 'asana', name: 'Asana', category: 'project_management', areas: ['issue_tracker'], integrations: [native()] },
  ...([['clickup', 'ClickUp'], ['monday', 'Monday'], ['trello', 'Trello'], ['basecamp', 'Basecamp'], ['shortcut', 'Shortcut']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'project_management', areas: ['issue_tracker'], integrations: [api('oauth2')] })),

  // Design, marketing, identity
  ...([['figma', 'Figma'], ['miro', 'Miro'], ['canva', 'Canva'], ['framer', 'Framer'], ['webflow', 'Webflow']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'design', areas: ['design'], integrations: [api('oauth2')], rules: [{ match: /^publish/, risk: 'deploy' }] })),
  ...([['google-ads', 'Google Ads'], ['meta-ads', 'Meta Ads'], ['linkedin-ads', 'LinkedIn Ads'], ['tiktok-ads', 'TikTok Ads']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'marketing', areas: ['advertising'], integrations: [api('oauth2')],
      rules: [{ match: /budget|bid|(create|enable|resume)_(campaign|ad)/, risk: 'financial' }] })),
  ...([['search-console', 'Google Search Console'], ['ahrefs', 'Ahrefs'], ['semrush', 'Semrush']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'marketing', areas: ['seo'], integrations: [api()] })),
  ...([['mailchimp', 'Mailchimp'], ['klaviyo', 'Klaviyo'], ['customer-io', 'Customer.io'], ['beehiiv', 'Beehiiv'], ['buffer', 'Buffer'], ['hootsuite', 'Hootsuite']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'marketing', areas: ['email_marketing', 'social'], integrations: [api()],
      rules: [{ match: /^(send|schedule|publish)_/, risk: 'external_message' }] })),
  ...([['clerk', 'Clerk'], ['auth0', 'Auth0'], ['workos', 'WorkOS'], ['okta', 'Okta'], ['entra-id', 'Microsoft Entra ID'], ['stytch', 'Stytch'], ['firebase-auth', 'Firebase Auth']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'identity', areas: ['identity'], integrations: [api()],
      rules: [{ match: /^(create|update|delete|ban|suspend)_(user|role|organization|member)/, risk: 'admin' }] })),

  // Automation platforms: calling an existing workflow can do anything that workflow does.
  ...([['n8n', 'n8n'], ['zapier', 'Zapier'], ['make', 'Make'], ['pipedream', 'Pipedream']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'automation', areas: ['automation'], integrations: [{ kind: 'mcp', label: 'MCP', auth: 'mcp_token', official: true }],
      rules: [{ match: /^(run|trigger|execute|call)/, permission: 'workflow:execute', risk: 'execute' }] })),

  // Browser and web
  ...([['playwright', 'Playwright'], ['browser-mcp', 'Browser MCP']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'browser', areas: ['browser'], integrations: [{ kind: 'mcp', label: 'MCP (local)', auth: 'none', official: id === 'playwright' }],
      resourceAliases: { page: 'browser', tab: 'browser', element: 'browser' },
      rules: [
        { match: /navigate|goto/, permission: 'browser:navigate', risk: 'read' },
        { match: /snapshot|screenshot|read|console|network_requests/, permission: 'browser:read', risk: 'read' },
        { match: /click|hover|drag|select_option/, permission: 'browser:click', risk: 'write' },
        { match: /type|fill|press_key/, permission: 'browser:type', risk: 'write' },
        { match: /upload/, permission: 'browser:upload', risk: 'write' },
        { match: /submit/, permission: 'browser:submit', risk: 'external_message' },
        { match: /purchase|checkout|pay/, permission: 'browser:purchase', risk: 'financial' },
        { match: /evaluate|run_code/, permission: 'browser:execute', risk: 'execute' },
      ] })),
  ...([['tavily', 'Tavily', 'mcp.tavily.com'], ['exa', 'Exa', 'mcp.exa.ai'], ['brave-search', 'Brave Search', undefined], ['firecrawl', 'Firecrawl', 'mcp.firecrawl.dev'], ['apify', 'Apify', 'mcp.apify.com']] as const)
    .map(([id, name, host]): ProviderProfile => ({ id, name, category: 'browser', areas: ['web_search'], hosts: host ? [host] : undefined, integrations: [api()] })),

  // AI providers are connections too, but they are models an agent runs on, not tools.
  ...([['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['gemini', 'Google Gemini'], ['xai', 'xAI'], ['mistral', 'Mistral'], ['groq', 'Groq'], ['openrouter', 'OpenRouter'],
    ['together', 'Together'], ['fireworks', 'Fireworks'], ['cohere', 'Cohere'], ['replicate', 'Replicate'], ['fal', 'fal'], ['elevenlabs', 'ElevenLabs'], ['deepgram', 'Deepgram'], ['assemblyai', 'AssemblyAI']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'ai', areas: ['model_provider'], integrations: [api()] })),

  // Security
  ...([['snyk', 'Snyk'], ['semgrep', 'Semgrep']] as const)
    .map(([id, name]): ProviderProfile => ({ id, name, category: 'security', areas: ['code_security'], integrations: [api('bearer_token')] })),
];

const BY_ID = new Map(PROVIDER_PROFILES.map((profile) => [profile.id, profile]));

export function getProviderProfile(id: string | null | undefined): ProviderProfile | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Which provider an MCP server speaks for, from its URL, when nobody said. */
export function detectProvider(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  for (const profile of PROVIDER_PROFILES) {
    if (profile.hosts?.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) return profile.id;
  }
  return null;
}

/** Providers that can satisfy a capability area, for skills written against capabilities. */
export function providersForArea(area: string): string[] {
  return PROVIDER_PROFILES.filter((profile) => profile.areas.includes(area)).map((profile) => profile.id);
}
