# Crewly 0.2.0

This release runs as one application, with a conversation-first setup and
persistent conversations, text attachments, scheduled reminders and tasks. Use
local SQLite or a managed Turso libSQL primary. PostgreSQL remains supported for
existing installations and export. Cloud and Superserver are optional.

## Release gates

- CI must pass SQLite, libSQL and PostgreSQL, including migration/export tests.
- App CI must pass unit tests, the real-server UI test, and production Chromium
  smoke testing. A deterministic loopback model verifies plumbing, not live model
  quality. User model credentials are never part of release tests.
- Publish app `v0.2.0` first. `release.json` pins that app version; its tarball
  includes `crewly-app.json` with SHA-256 hashes. A version mismatch or corrupt
  asset stops fetching before a working UI is replaced.
- The server Release workflow builds signed native archives and the Node Docker
  image. It must unpack and boot the Linux archive, verify app/server versions,
  and verify checksums. `RELEASE_SIGNING_KEY` must already exist in Actions; never
  generate or rotate it for a routine release. The signature must cover the
  final checksums after all assets are added.

## Build and verify locally

Use Node 24 and Bun 1.4+. Build the coordinated app in sibling `../app` first.

```sh
npm ci --include=optional
npm run typecheck
npm test
node --test scripts/app-bundle.test.mjs
npm run build
npm run fetch:app
bun run scripts/build-binary.ts bun-linux-x64
sh deploy/scripts/package-release.sh linux amd64 dist-binary/crewly_linux_amd64/crewly-server web
mkdir -p /tmp/crewly-release-check
tar -xzf deploy/dist/crewly-server_linux_amd64.tar.gz -C /tmp/crewly-release-check
node scripts/smoke-release.mjs /tmp/crewly-release-check
```

Only tag the checked server commit `v0.2.0` once app `v0.2.0` is published. The
Release workflow preserves existing Ed25519 signing and installer verification.
Do not treat source checks or an unsigned local archive as a published release.

Alternatively, create `release/v0.2.0` at the checked `main` commit after the app
release is available. The Release workflow runs the same build and signing
gates, then creates the tag and publishes Latest. It refuses to move a tag that
already points at different code; the final checksum signature is still required.

## Hosting and recovery

See [simple-hosting.md](docs/simple-hosting.md). Render runs one paid service and
one persistent disk; Turso stores the SQL data. Use one instance and keep it
online for reminders. Keep the original encryption key and device identity.
Cloud account/organization/subscription data is not imported into standalone
server accounts. Export only after stopping writes and keeping a rollback copy.

This candidate does not provision hosting, change live DNS or migrate an
existing production database. The first-run code on Render comes from
`CREWLY_SETUP_TOKEN` in its Environment dashboard.
