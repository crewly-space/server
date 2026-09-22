# Secrets

Crewly keeps the credentials that agents and tools need, such as MCP server tokens,
runtime environment variables and integration keys, in a vault on the server.

## What the vault guarantees

- **Encrypted at rest.** Each value is encrypted with AES-256-GCM under the server's
  secret key before it's written to SQLite.
- **Write-only over the API.** A value is sent once, when it's created or rotated. After
  that, no API returns it, not even to an owner.
- **Explicit grants.** A secret is granted to specific things: an agent, a runtime, an
  MCP server, an automation, an integration or a skill. Anything that wasn't granted
  a secret can't read it.
- **Referenced by name.** Configuration names a secret instead of containing it:
  `Authorization: Bearer {{secret:GITHUB_TOKEN}}`. The reference is resolved when the
  secret is used, and only for a grantee that holds it.
- **Audited.** Every create, rename, rotation, revocation, grant, ungrant, delete, and
  every read by a grantee, is recorded in the audit log (`GET /api/v1/secrets/audit`).
  The log keeps history after a secret is deleted.
- **No surprise breakage.** Deleting a secret, or renaming one that configuration refers
  to, is refused with a list of what depends on it. Pass `?force=true` to go ahead anyway.
- **Revoke vs. delete.** Revoking destroys the value but keeps the secret, its grants
  and its references. Uses fail until a new value is rotated in. Deleting removes the
  secret entirely.

## Where the key lives

### Self-hosted (default)

On first boot the server generates a 32-byte key at `<data dir>/secrets.key` with
mode `0600`. Back it up together with the database: without it, the stored secrets
can't be decrypted. Anyone who can read both files can read every secret, so
protect the data directory the same way you would protect the credentials themselves.

### Managed (Crewly Cloud, or your own secret manager)

Set `CREWLY_SECRETS_KEY` to a base64-encoded 32-byte key, supplied by your platform's
secret store. The key is never written to disk; only a fingerprint of it is
(`secrets.key.managed`). The server refuses to start if:

- it has run with a managed key before and the variable is now missing, since it would
  otherwise generate a fresh key and orphan every secret;
- the key differs from the one the secrets were written with;
- a local `secrets.key` already exists and doesn't match. To move a self-hosted server
  onto a managed key, set `CREWLY_SECRETS_KEY` to the base64 of the existing
  `secrets.key`, start once, then remove the file.

Generate a key with `openssl rand -base64 32`.

## API

All routes require an owner or admin.

| Method | Path | |
|---|---|---|
| GET | `/api/v1/secrets` | List metadata and grants. Never returns values. |
| POST | `/api/v1/secrets` | `{name, value, description?}`. Names are `UPPER_SNAKE_CASE`. |
| PATCH | `/api/v1/secrets/:id` | Rename or describe. A rename that would orphan references returns 409 unless `?force=true`. |
| PUT | `/api/v1/secrets/:id/value` | Rotate (also restores a revoked secret). |
| POST | `/api/v1/secrets/:id/revoke` | Destroy the value and keep the record. |
| PUT | `/api/v1/secrets/:id/grants` | `{grants: [{type, id}]}`. Replaces the grant list. |
| GET | `/api/v1/secrets/:id/dependents` | What would break. |
| DELETE | `/api/v1/secrets/:id` | Returns 409 with dependents unless `?force=true`. |
| GET | `/api/v1/secrets/audit` | `?secretId=&limit=` |
