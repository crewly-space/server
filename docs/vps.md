# One Crewly app on your VPS

Recommended for an existing Ubuntu VPS with Docker Compose v2 and nginx:
**one Node container, one SQLite data volume, one loopback port, one HTTPS
origin**. No separate database process, Cloud, Superserver or frontend host is
required. SQLite is the default. Use Turso only if you specifically want a
managed remote database; this backup/restore workflow is for local SQLite.

## Install on your VPS

Clone the server from `main` and prepare its pinned app. The build
step uses disposable Node containers; you do not need Node installed on the VPS.
Run these from the server checkout (the first two commands may take a few minutes):

```sh
git clone --branch main https://github.com/crewly-space/server.git crewly-server
cd crewly-server
./deploy/vps/crewly-vps install https://app.crewly.space 8787
cd deploy/vps
./crewly-vps setup-code
```

If 8787 is already in use, choose another local port in `init` (for example
8790). Initialization refuses to overwrite existing keys. Keep the generated
`.env` private and preserve it across updates. You can place the source checkout under `/opt/crewly-server` from the start. Keep `crewly-vps`, `compose.yaml` and `.env` together in the deployment folder; keep that folder in place after backups are created because saved backup paths are absolute. Docker's named volume stays associated with project `crewly-vps`.

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
./crewly-vps upgrade                        # fetch source, build, back up and update
./crewly-vps update IMAGE:VERSION           # or use a published/prebuilt image
./crewly-vps rollback
./crewly-vps restore /absolute/path/to/backups/TIMESTAMP
```

`upgrade` fast-forwards a clean source checkout, rebuilds the pinned app and server, then uses the same protected update path. Build or network failures leave the running app alone. `update` accepts a versioned image or digest. It downloads first, backs up the
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
