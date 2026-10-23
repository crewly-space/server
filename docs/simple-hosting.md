# One application on Render + Turso

Crewly can run as one always-on Node service with its own web app, login,
settings, agents, WebSockets and scheduled tasks. Turso manages the SQL primary.
A single persistent disk keeps uploads, the device pairing identity, encryption
key metadata. No Crewly Cloud, Superserver, billing
service, separate PostgreSQL process, reverse proxy or frontend deployment is
needed for this setup.

## Fresh deployment

1. Create a **libSQL / SQLite-compatible** database in [Turso](https://turso.tech/).
   Use the ordinary libSQL engine, not the experimental Turso rewrite. Copy its
   database URL and a read/write database token. The CLI equivalents are:

   ```sh
   turso db create crewly
   turso db show crewly --url
   turso db tokens create crewly
   ```

2. In [Render](https://dashboard.render.com/), choose **New → Blueprint**, connect
   `crewly-space/server` (or your fork), and select the branch containing this
   change. The root `render.yaml` defines the entire application. Enter
   `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` when prompted. Render generates and
   retains `CREWLY_SECRETS_KEY` and `CREWLY_SETUP_TOKEN` automatically. This uses
   one paid Starter web service and a 1 GB persistent disk; Turso usage is billed
   separately under its selected plan. No API model key is required to boot.

3. Open the service's public URL. Copy `CREWLY_SETUP_TOKEN` from the service's
   **Environment** tab into the first-run setup code field, create your owner
   account, and connect a model provider in the app. The setup token no longer
   authorizes account creation after the first owner exists.

4. Optionally point your app domain at the Render service. Render manages HTTPS.
   If you use a custom domain, set `CREWLY_PUBLIC_URL` to that HTTPS origin so
   invite/notification links use it. Without it Crewly uses `RENDER_EXTERNAL_URL`.

The Blueprint downloads the **published** app release pinned in `release.json` during build.
The coordinated app release must be published first; a missing or mismatched app stops the build. `APP_VERSION` can pin a
specific app release, or `CREWLY_APP_TARBALL` can select an existing built app
archive. The app is served from the same origin as the API.

## What to preserve

- Keep the disk mounted at `/var/data/crewly` across deploys. It contains uploads
  and the pinned server identity used by paired devices. Turso alone is not a
  backup of these files. Include the disk in your backup/recovery plan.
- Preserve the original `CREWLY_SECRETS_KEY`. It encrypts model/API credentials.
  The remote database stores its fingerprint and refuses a different key even
  if a new deployment starts with a completely empty disk.
- Use **one service instance**. Jobs, schedules and WebSocket delivery currently
  share that process; this is not a horizontally scaled hosted SaaS setup.
- A persistent-disk deployment has a brief interruption during redeploys. Keep
  the service always on for reminders; a sleeping/free web tier is unsuitable.
- No token is put in browser code or a committed configuration file. Turso is
  accessed only by the server. A failed primary connection fails startup instead of
  creating an apparently new empty workspace.

## Existing SQLite or PostgreSQL data

This is an explicit migration, not an automatic destructive cutover. Keep the
old deployment and a backup until the new one has been checked.

1. Stop application writes. In the new server checkout run `npm ci` and
   `npm run build`, then run the export with the **old** `CREWLY_DATA_DIR`,
   `CREWLY_DATABASE_URL` (for PostgreSQL) and original encryption key configured:

   ```sh
   npm run db:export -- /absolute/path/to/crewly-export.db
   ```

   This produces a new SQLite-compatible file, preserves IDs and encrypted
   credentials, validates foreign keys, refuses an existing output filename,
   and leaves the source application rows unchanged. It also pins the original
   key fingerprint in the export. Source and destination must use this schema
   version; unknown tables or missing tables stop the export.

2. Import it into a **new** Turso database:

   ```sh
   turso db create crewly --from-file /absolute/path/to/crewly-export.db
   ```

3. Before first boot of the new service, set its `CREWLY_SECRETS_KEY` to the old
   key rather than the Blueprint-generated new key. Copy the old `attachments/`
   directory and `agentd-server-key.json` onto the persistent disk. If the old
   key lives in `secrets.key`, it is 32 raw bytes; encode those same bytes as
   base64 for the environment value. Do not generate a replacement key.

4. Start Crewly with the new database URL/token. Check sign-in, existing chats,
   a model response, an attachment download and paired-device access before
   changing DNS or stopping the old deployment permanently. Keep the old
   database available for rollback. These instructions do not migrate Cloud
   organizations, subscriptions or billing records into the standalone server.

## Docker or another long-running Node host

`deploy/Dockerfile` includes a published web app automatically and fails the
build if it cannot obtain one. A prepared `web/` takes precedence; the build
argument `CREWLY_APP_VERSION` pins a release. Run the image with a persistent
`/data` volume and `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CREWLY_SECRETS_KEY`
and `CREWLY_SETUP_TOKEN`. `CREWLY_PUBLIC_URL` is your public HTTPS origin.

On native Node hosts Crewly also accepts `PORT`; explicit `CREWLY_PORT` wins.
The ordinary local install still uses built-in SQLite when no remote database
is selected. Turso uses the optional official `@libsql/client` package, included by
`npm ci --include=optional` and the Docker build, rather than the portable
single-file server binary. The legacy PostgreSQL adapter remains available for
rollback; it is not required by the new deployment.

References: [Turso SDKs](https://docs.turso.tech/sdk/ts/reference),
[Turso import](https://docs.turso.tech/cli/db/create),
[Render Blueprint](https://render.com/docs/blueprint-spec),
[Render disks](https://render.com/docs/disks).
