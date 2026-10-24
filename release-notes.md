## Crewly Server 0.2.0

Run Crewly on one VPS: one container, one SQLite volume and one localhost port
behind your existing nginx HTTPS configuration. Crewly Cloud, Superserver and
an external database are optional. Managed Turso/libSQL and PostgreSQL remain
available for installations that need them.

- **An assistant you can use immediately.** Create an account, connect a model
  provider and start a conversation. The bundled app includes guided assistant
  roles, attachments, clearer chat and recoverable settings.
- **Persistent reminders and work.** Save one-off or recurring reminders and
  assistant tasks from chat or a form, inspect results and cancel future runs.
  Requests are deduplicated, including retries after a scheduled task ran.
- **Proactive teams.** Enabled follow-ups can consult up to two permitted,
  available teammates and return one combined result. Daily limits, daytime
  hours, DND, access checks and stale-answer cancellation bound background work.
- **VPS operations.** `deploy/vps/crewly-vps` supplies install, upgrade, backup,
  restore, rollback, doctor and setup-code commands. Failed updates restore
  both the previous image and data. Backups retain the encryption key and
  exact image identity.
- **Verified distribution.** Archives include the matching web app. Its manifest
  verifies asset hashes. The final checksum list has the Ed25519 signature
  expected by the existing CLI; no installer trust-key change is required.

See [VPS setup and recovery](https://github.com/crewly-space/server/blob/v0.2.0/docs/vps.md)
and [proactive assistants](https://github.com/crewly-space/server/blob/v0.2.0/docs/proactive.md).
Native archives are provided for Linux and macOS (amd64/arm64) and Windows
(amd64). A container archive is included as an alternative to GHCR.

Keep a backup before migrating an existing installation. Preserve its encryption
key and device identity. The standalone database export does not automatically
migrate Cloud organizations, billing or subscriptions. This release does not
change an existing VPS, DNS or nginx configuration by itself.
