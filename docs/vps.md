# One Crewly app on your VPS

Recommended for an existing Ubuntu VPS with Docker Compose v2 and nginx:
**one Node container, one SQLite data volume, one loopback port, one HTTPS
origin**. No separate database process, Cloud, Superserver or frontend host is
required. SQLite is the default. Use Turso only if you specifically want a
managed remote database; this backup/restore workflow is for local SQLite.

## Deploy this candidate before public releases exist

Clone the server at the candidate branch and prepare its pinned app. The build
step uses disposable Node containers; you do not need Node installed on the VPS.
Run these from the server checkout (the first two commands may take a few minutes):

```sh
git clone --branch codex/simple-hosting https://github.com/crewly-space/server.git crewly-server
cd crewly-server
docker run --rm -v "$PWD:/workspace" -w /workspace node:24-bookworm node scripts/prepare-vps.mjs
docker build -f deploy/Dockerfile -t crewly-local:0.2.0 .
cd deploy/vps
./crewly-vps init https://app.crewly.space crewly-local:0.2.0 8787
./crewly-vps up
./crewly-vps setup-code
```

If 8787 is already in use, choose another local port in `init` (for example
8790). Initialization refuses to overwrite existing keys. Keep the generated
`.env` private and preserve it across updates. You can move this whole deployment
folder to `/opt/crewly` before initialization; keep `crewly-vps` and `compose.yaml`
together. Docker's named volume stays associated with project `crewly-vps`.

Merge the generated `nginx.conf` **location block** into the domain's existing
HTTPS vhost, then run `sudo nginx -t && sudo systemctl reload nginx`. Keep the
existing certificate and TLS settings. The script does not edit nginx, take ports
80/443, stop old containers or change DNS. Test on a new subdomain first if the
old app is still live; do not create two nginx vhosts for the same domain.

Open the domain, paste the setup code and create your account. Connect your model
provider. Uploaded files, conversations, schedules and device identity all belong
to this deployment; model credentials are encrypted with the generated key.

## Everyday operations

From `deploy/vps` (or the copied `/opt/crewly` folder):

```sh
./crewly-vps doctor
./crewly-vps logs
./crewly-vps backup
./crewly-vps update ghcr.io/crewly-space/server:vNEXT
./crewly-vps rollback
./crewly-vps restore /absolute/path/to/backups/TIMESTAMP
```

`update` accepts a versioned image or digest. It downloads first, backs up the
entire stopped volume and original environment, starts the new version, and waits
for readiness. Failed startup automatically restores the previous **image and
data**, including the encryption key. `rollback` returns to the most recent
backup. Restore takes a safety backup before replacing data. A failed restore
leaves the application stopped and prints the safety backup location.

Backups include private uploads, API-key encryption material and device identity;
only the deployment owner should read them. Checksums detect damaged files. Copy
successful backup directories off the VPS. Keeping backups on the same VPS is
useful for updates, but does not protect against losing the VPS disk. A daily
root/user cron entry can run the same `backup` command; each operation is locked
so an update and a backup cannot overlap. Archive retention is explicit: inspect
and remove old backup directories after confirming an off-server copy exists.

A backup briefly stops this single instance. Reminders scheduled during downtime
catch up after restart; delivery is not an exact-second alarm. Keep the server
online for background agent work. AI tasks use credits from your model provider;
plain reminders do not call a model.

This creates a fresh standalone instance. It does not import accounts from the
old Cloud database or overwrite an existing Crewly data volume. To migrate an
existing standalone server, use the data/key migration in `simple-hosting.md`,
then verify sign-in, attachments and paired devices before changing nginx.
