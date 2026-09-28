# The tool platform

Crewly lets agents act across a company's tools without building every integration into
Crewly itself. The model is one pipeline:

```text
Provider      what Crewly knows about a service (GitHub, Sentry, Stripe…)
   ↓
Connection    a native connector or an MCP server, with its own credentials and health
   ↓
Tools         normalized: one name, schema, risk and permission, whatever the source
   ↓
Permissions   grants (which tools an agent has) + policies (what happens when it calls one)
   ↓
Skills        workflows that ask for capabilities and permissions, not vendors
   ↓
Agents
```

The code is in `src/tools/` (catalog, classifier, policies, runtime, audit, search,
connector SDK), `src/mcp/` (client, OAuth, health), `src/skills/` and `src/registry/`.

## Providers and connections

`src/tools/providers.ts` describes 170 providers across development, cloud, databases,
monitoring, finance, analytics, CRM, support, communication, knowledge, project
management, design, marketing, identity, automation, AI and browser tools: their category,
the **capability areas** they cover (`code_host`, `error_tracking`, `payments`, …), how
they can be connected (native, official MCP, API) and, for the ones that need it, rules
for classifying their tools. A profile contains no logic an agent depends on.

A provider can have any number of connections — the native GitHub OAuth connector, GitHub's
official MCP server, a company's own GitHub Enterprise MCP server, two GitHub accounts —
and each keeps its own credentials, health and grants.

Native connectors are declared with the connector SDK:

```ts
export default defineConnector({
  id: 'stripe', name: 'Stripe', category: 'finance',
  auth: { type: 'oauth2' },
  tools: [listCustomers, createRefund],
  permissions: ['customer:read', 'refund:create'],
});
```

The ten built-in OAuth connectors (`src/tools/native.ts`) are declared this way over their
existing HTTP implementations. Supported auth types: `oauth2`, `api_key`, `bearer_token`,
`basic`, `service_account`, `github_app`, `custom_headers`, `cli`, `mcp_oauth`, `mcp_token`,
`none`. MCP servers are covered in [MCP servers](mcp.md).

## Normalized tools

Every tool from every live connection becomes a `NormalizedTool`:

| Field | Example |
|---|---|
| `ref` | `github.create_pull_request` — stable; policies and the audit log use it |
| `modelName` | `github__create_pull_request` — what the model sees |
| `risk` | `read`, `write`, `external_message`, `delete`, `execute`, `deploy`, `financial`, `admin`, `dangerous` |
| `permission` | `pull_request:create` — the shared `resource:action` vocabulary skills use |
| `source` | connection kind, id, name, trust, and the tool's own name |

The namespace is the provider's id. When a second connection for the same provider offers
a tool the first already has, it is qualified by its account or name (`github-acme`),
oldest connection first, so names do not collide and do not move between restarts.

Classification (`src/tools/classify.ts`) checks the provider's rules first, then MCP
annotations, then the verb in the tool's name. An unknown tool is `write`, never `read`.
A server's read-only claim is believed only from `official` or `verified` servers; a
destructive claim is believed from anyone.

Schemas are checked before a model sees them (object type, under 32 KB, no deeper than 12
levels, no remote `$ref`); a tool that fails is not offered. Arguments are checked against
the schema before anything is sent.

## Policies

Granting a tool decides whether an agent sees it. A policy decides what happens when it
calls it:

- `always` — run it
- `ask_once` — ask a person the first time; after that, run it
- `ask_every_time` — ask for each exact call
- `blocked` — never; the tool is not even offered to the model

Rules select tools by exact `tool` ref, `permission`, `connection` or `risk`, for one agent
or the whole workspace. The most specific rule wins — agent before workspace; tool,
permission, connection, then risk. Without a rule:

| Risk | Default |
|---|---|
| read | always (ask once from `community`/`unverified` servers) |
| write | ask once |
| external message, delete, execute, deploy, financial | ask every time |
| admin, dangerous | blocked |

Providers can be stricter: Stripe payouts are blocked, refunds and transfers ask every time.

Two things no rule can relax: a **workspace block** applies to every agent, and
**financial, dangerous and destructive calls always ask** at least every time. Capability
policies an admin set explicitly before tools had their own (`network.access`,
`external.side_effect`, …) still hold: `deny` blocks, `ask` asks every time.

Database tools are judged per call. A single `SELECT` through `execute_sql` is a read; an
`INSERT` or filtered `UPDATE` is a write; `DROP`, `TRUNCATE`, `ALTER`, or a `DELETE`/`UPDATE`
without a real `WHERE` is destructive and asks every time.

Only people who manage integrations can set a rule that lets an agent act without asking;
an agent's owner can make their own agent stricter.

## Approvals

A call that must ask creates an approval with what a person needs to decide: the tool,
connection and its trust, risk, permission, why it asked, and the arguments (redacted).
The call itself is stored encrypted with the approval. The model is told approval was
requested and not to retry.

Approving runs exactly that call — after checking the agent still has the tool and it has
not since been blocked — posts the result in the conversation, and gives the agent a turn
to carry on. Approving with `remember` also sets an `always` rule for that agent and tool
(floors still apply). Who decided, and when, is kept on the approval; `GET
/api/v1/approvals/history` lists decisions. Tool approvals expire after 24 hours.

## Audit log

Every tool execution, and every block or approval request, is a row in `tool_executions`:
agent, user, run, conversation, skill, connection, provider, tool, risk, permission,
arguments with secrets redacted, status, policy, approval, result size, duration and error.
Result contents are never stored. Redaction removes secret-looking keys and values
(tokens, keys, JWTs, connection strings) and the literal value of every secret resolved
for that call.

## Secrets

Credentials never enter the model's context. A tool call goes agent → tool runtime →
credential resolved (vault reference, OAuth token, connector token) → provider. Vault
secrets and OAuth tokens are encrypted at rest; vault reads are audited per grantee.

## Tool search

Above 24 tools an agent is offered `search_tools` instead of every schema. A search
returns up to eight matches and makes them callable for the rest of the turn. Scoring is
lexical over name, permission, namespace, provider, capability areas and description, with
common synonyms folded (PR → pull request, crash → errors). Nothing is hosted or embedded.

## Skills

A skill is a workflow, not an API wrapper. Its manifest declares what it needs by
capability, so it works with whichever equivalent provider is connected:

```yaml
---
name: Production Bug Fixer
slug: production-bug-fixer
requires: {"error_tracking": ["sentry", "datadog", "new-relic"], "code_host": ["github", "gitlab"]}
optional: {"deployment": ["vercel", "netlify", "cloudflare"], "chat": ["slack"]}
permissions: ["errors:read", "repo:read", "branch:create", "commit:create", "pull_request:create", "deployment:preview"]
approvals: ["pull_request:merge", "deployment:production"]
---
Instructions…
```

An empty provider list accepts any provider with that capability. `GET
/api/v1/skills/:id/plan` shows which connections satisfy each capability, which exact tools
each permission maps to, and what is missing. `POST
/api/v1/agents/:id/skills/:skillId/authorize` grants those tools (recorded against the
skill), sets `permissions` to `always` and `approvals` to `ask_every_time`, and never
loosens an existing block.

The catalog ships Production Bug Fixer, Incident Commander, Release Manager, Customer
Issue Resolver, Revenue Analyst, Growth Analyst, Security Auditor, Cloud Cost Optimizer,
Sales Call Prep and Company Daily Brief.

## Marketplace

The registry lists the Crewly catalog, the official MCP Registry (cached ten minutes per
query), and an owner-configured private registry. Each listing carries category, provider,
trust, source repository, last update, transport, auth type, read and write permissions,
network and filesystem access, required secrets and a risk level. Trust is never taken on
a third-party registry's word: MCP Registry entries under a verified domain namespace are
`official`, GitHub namespaces are `community`, and a private registry can mark its items
`verified` at most.

## API

| Endpoint | |
|---|---|
| `GET /api/v1/tools?q=` | the normalized catalog, optionally searched |
| `GET /api/v1/tools/providers` | provider profiles with live connection counts |
| `GET /api/v1/connections` | every connection with one health vocabulary |
| `GET /api/v1/agents/:id/tool-access` | each tool an agent has, its mode and why |
| `DELETE /api/v1/agents/:id/tool-approvals` | forget "ask once" approvals |
| `GET`/`PUT /api/v1/tool-policies` | an agent's or the workspace's rules |
| `GET /api/v1/tool-executions` | the audit log |
| `POST /api/v1/mcp-servers/:id/oauth/start`, `POST /api/v1/mcp-servers/oauth/complete` | MCP OAuth |
| `GET /api/v1/skills/:id/plan`, `POST /api/v1/agents/:id/skills/:skillId/authorize` | skills |
| `POST /api/v1/approvals/:id/respond` (`remember`), `GET /api/v1/approvals/history` | approvals |

The SDK exposes these as `client.tools`, `client.mcp.startOAuth/completeOAuth/signOut`,
`client.skills.plan/authorize` and `client.approvals.respond/history`.

## Not yet

- Grants are per agent (with skill attribution). Granting a connection to a team needs
  teams, which Crewly does not have yet.
- MCP servers are workspace connections; native connectors belong to the user who
  connected them.
- stdio servers get limits, not isolation; a container launcher is future work.
- Provider-specific native connectors beyond the ten OAuth ones. Official MCP servers cover
  the Phase 2 targets (GitHub, Vercel, Cloudflare, Sentry, Stripe, Notion, Linear, PostHog,
  Supabase, Neon…), and `defineConnector` is how to add a native one when an MCP server
  falls short.
- `crewly mcp …`, `crewly skills …` and `crewly approvals` belong in the CLI; the SDK has
  everything they need.
