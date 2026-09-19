# Crewly server instructions

GitHub organization: crewly-space. One of four repositories:
`server` (this), `app`, `cli`, `cloud`.

This repo **owns** `src/protocol` and `src/sdk`. The app and CLI commit
vendored copies and refresh them with `npm run vendor:sync`. So:

- A protocol change lands here first, then in the consumers.
- Never edit `src/protocol` or `src/sdk` in another repository — the drift
  check in their CI will fail and the edit will be overwritten.
- Breaking the wire format means a coordinated release across repos. Prefer
  additive changes.

`test/sdk/` boots a real server in-process. Those tests live here rather than
with the app precisely so they can do that.

Architecture rule: Agent != Model != Runtime != Runtime Session.
Runtime Session = Agent + Conversation + Runtime + Workspace.

Keep self-hosting lightweight: one server process/container, one port, one data
directory, SQLite by default, no mandatory Redis/Postgres/Kafka.

The web UI is not built here. See `scripts/fetch-app.mjs`.
