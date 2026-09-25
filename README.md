# Crewly Server

The self-hostable Crewly server: API, WebSocket hub, job runner, and SQLite
storage. This repository also owns the two things that define the server's
contract with everything else — the wire **protocol** and the TypeScript
**SDK** — because a contract belongs with the side that enforces it.

```text
src/
  protocol/   wire schemas and types        (owner; vendored by app + cli)
  sdk/        TypeScript client            (owner; vendored by app)
  agents/ conversations/ messages/ memory/ providers/ runtime/ ws/ ...
test/
  sdk/        SDK<->server integration tests, run against the real server
deploy/       Dockerfile, compose, Caddy, systemd, install scripts
```

## Develop

Requires Node.js 24+. Bun 1.4+ only for the native binary build.

```sh
npm ci
npm test          # 315 tests, including the SDK integration suite
npm run typecheck
npm run dev
```

## The web UI is not built here

The app is a separate repository on its own release cadence. To serve it:

```sh
npm run fetch:app          # sibling ../app/dist, else the app release
docker build -f deploy/Dockerfile -t crewly-server .
```

Without that step the image is still valid — the server just serves no UI.

## External connectors

The server exposes one first-class Connectors model for provider-native OAuth
connections. GitHub is the first provider; configure a GitHub OAuth App with
the callback URL used by the app and set `CREWLY_GITHUB_CLIENT_ID` and
`CREWLY_GITHUB_CLIENT_SECRET` before starting the server. Connector tokens are
encrypted with the same database secret key as the secrets vault. Connecting a
service does not grant it to an agent: administrators must add an explicit
connector capability grant, and calls are recorded in connector audit history
without storing the token.

## Self-hosting shape

One server process, one port, one data directory, SQLite by default. No
mandatory Redis, Postgres, or Kafka. Keep it that way.
