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

## Releasing

Server releases are signed. The CLI downloads `checksums.txt` and
`checksums.txt.sig` from the release and refuses to install unless the
signature verifies against the Ed25519 key it embeds (`RELEASE_PUBLIC_KEY` in
the CLI's `src/server-install.ts`). So, on every release:

- `.github/workflows/release.yml` must keep the "Sign the checksums" step
  *after* the last write to `checksums.txt`, and must upload
  `checksums.txt.sig`. Adding an asset to `checksums.txt` later without
  re-signing breaks every CLI install.
- The private key is the `RELEASE_SIGNING_KEY` Actions secret (PEM, Ed25519).
  Never commit it, print it, or generate it inside an agent session.
- Rotating the key means updating `RELEASE_PUBLIC_KEY` in the CLI and cutting a
  CLI release *before* a server release signed with the new key. The workflow
  logs the public key it signed with; it must match the CLI's.
