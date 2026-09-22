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

## Credentials

Put credentials in the [secrets vault](secrets.md) and refer to them by name:

```
Authorization: Bearer {{secret:GITHUB_TOKEN}}
```

Then grant the secret to the MCP server. References resolve only for secrets granted to
that server, and each read is audited. A credential pasted straight into a header or env
value also works: it's stored encrypted and shown as `••••••`. Using a reference is
better, because it can be rotated and audited.

## Test connection

`POST /api/v1/mcp-servers/:id/test` connects, runs `initialize`, lists every tool
(following pagination), stores them, and disconnects. A failure is recorded as the
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
- Agents see each tool as `mcp_<server>_<tool>`. Calls show up in the run trace as
  `tool.call` events, which record the name, duration and outcome but not the contents.

Each tool call opens a fresh session. That keeps servers stateless from Crewly's side, at
the cost of one extra round trip per call.
