# MCP servers

Admins connect [Model Context Protocol](https://modelcontextprotocol.io) servers to a Crewly
server, and then give individual agents individual tools from them.

## Transports

- **HTTP (streamable).** A URL such as `https://mcp.example.com/mcp`, with optional headers.
  Both JSON and server-sent-event replies are understood, and the `Mcp-Session-Id` the
  server issues is carried for the rest of the session.
- **stdio (local).** A command and its arguments, started on the Crewly server itself. It
  runs with the Crewly process's privileges, so it's **off unless the operator sets
  `CREWLY_MCP_STDIO=1`**. The process inherits only `PATH`, `HOME`, `LANG` and the temp
  directory variables from Crewly, plus the environment you configure. Crewly's own
  secrets are never passed to it.

## Signing in with OAuth

Servers such as Sentry's and Vercel's accept only OAuth. `POST /api/v1/mcp-servers/:id/oauth/start`
finds the authorization server from the MCP server's protected resource metadata (RFC 9728, from
its `WWW-Authenticate` header or the well-known path), reads that server's metadata (RFC 8414),
registers Crewly as a client when dynamic registration is allowed (RFC 7591), and returns an
authorization URL with PKCE and the `resource` parameter (RFC 8707). The app sends the browser
there and hands the returned `code` and `state` to `POST /api/v1/mcp-servers/oauth/complete`,
which exchanges it and discovers the server's tools straight away.

Tokens are stored encrypted with the server, refreshed a minute before they expire, and
attached at call time. The API only ever says whether a server is signed in. A server whose
refresh fails is marked `expired` until someone signs in again.

## Credentials

Put credentials in the [secrets vault](secrets.md) and refer to them by name:

```
Authorization: Bearer {{secret:GITHUB_TOKEN}}
```

Then grant the secret to the MCP server. References resolve only for secrets granted to
that server, and each read is audited. A credential pasted straight into a header or env
value also works: it's stored encrypted and shown as `••••••`. Using a reference is
better, because it can be rotated and audited.

## Test connection and discovery

`POST /api/v1/mcp-servers/:id/test` connects, runs `initialize`, lists every tool
(following pagination) with its annotations, and, when the server says it has them, its
resources and prompts. It stores all of that with the server's name, version, protocol
version, capabilities and instructions, and disconnects. A failure is recorded as the
server's `lastError`, in words that say what to fix: command not found, credentials
refused (401), no endpoint at that path (404), timed out, not an MCP server, a secret that
isn't granted, or local servers disabled.

## Tools and permissions

- An admin can switch individual tools off for the whole server (`PUT /mcp-servers/:id/tools`).
- An admin declares what a server can do: `shell`, `filesystem`, `network`. Giving an
  agent tools from a server that declares any of these requires an admin **and** an
  explicit acknowledgement of each capability. If a capability is declared later, the
  tools are withdrawn from agents until someone acknowledges it again.
- An agent's owner can give it tools from servers that declare none of these.
- Tools are normalized with native connectors' into one catalog (see
  [the tool platform](tool-platform.md)): a server Crewly recognises by its host, or one whose
  `provider` is set, puts its tools in that provider's namespace, so the model sees
  `github__create_pull_request` whichever connection supplied it. Other servers use their name.
- Every call goes through tool policies, approvals and the audit log like any other tool.

## Trust

Each server has a trust level: `official` (published by the service itself), `verified`
(reviewed by Crewly, or vouched for by a registry the owner chose), `community`, or
`unverified`. Servers added by hand start `unverified`; an admin can change that. Trust
matters in two places: a server's claim that a tool is read-only (`readOnlyHint`) is only
believed from `official` or `verified` servers, and reads from `community` or `unverified`
servers ask once before their first use.

## Health and resilience

Every call moves a server's health: `connected`, `degraded` after a failure, `error` after
three in a row or before any success, `expired` when credentials are refused, and
`disabled` when switched off. After five failures in a row, calls fail fast for 30 seconds
instead of each waiting out a timeout. A transient failure (timeout, unreachable, 5xx) of a
read-only call is retried once; a write is never retried. Responses over 8 MB are refused
on either transport.

## Local servers

stdio servers stay off unless the operator allows them. When allowed they get a minimal
environment, a per-request timeout, an 8 MB output limit, and are killed (SIGTERM, then
SIGKILL two seconds later) when the session ends. They run with Crewly's own OS privileges;
isolating them further (a container, a separate user) is the operator's job, and hosted
Crewly never enables them.

Each tool call opens a fresh session. That keeps servers stateless from Crewly's side, at
the cost of one extra round trip per call.
