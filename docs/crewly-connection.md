# Connect Crewly

A self-hosted server can opt into Crewly-managed services, such as the AI Gateway,
Crewly Mail and Sign in with Crewly, by connecting to a Crewly account. It's optional.
A server that never connects, or disconnects later, keeps working with its own data,
local providers and bring-your-own keys.

## How connecting works

1. An owner or admin starts **Connect Crewly** (`POST /api/v1/server/crewly/connect`).
   The server asks Crewly for a link code and shows it with a verification URL.
2. The owner opens that URL, signs in to Crewly there and approves the code, choosing
   which services the server may use. The server never sees the owner's password or
   session.
3. The server collects its credential (`POST /api/v1/server/crewly/connect/poll`, repeated
   every `interval` seconds while `status` is `pending`).

The server is then a principal of its own in Crewly, with a stable instance id and a
credential scoped to the granted capabilities (`models:read`, `inference`, `mail:send`,
`identity`). The credential can't act as the owner's account.

## What the server keeps

- The credential is encrypted with the server's secret key (see [secrets](secrets.md))
  and never returned by any API or sent to a browser.
- Only one connection exists per server. To connect to another account, disconnect first.

## Managing it

All routes require an owner or admin.

| Method | Path | |
|---|---|---|
| GET | `/api/v1/server/crewly` | Status (`disconnected`, `pending`, `connected`, `revoked`), instance id, scopes, pending link code. |
| POST | `/api/v1/server/crewly/connect` | `{name?, scopes?}`. Starts a link. |
| POST | `/api/v1/server/crewly/connect/poll` | Checks once whether the owner approved. |
| POST | `/api/v1/server/crewly/refresh` | Picks up scopes changed in Crewly and notices a revocation. |
| POST | `/api/v1/server/crewly/credential/rotate` | New credential, same instance. |
| DELETE | `/api/v1/server/crewly` | Disconnects locally and revokes the credential in Crewly when it can be reached. |
| GET | `/api/v1/server/crewly/audit` | Linking, scope changes, rotation, revocation, disconnection. Never secret values. |

In Crewly, the account's **Connected servers** page lists every connected server with
its last-seen time and credential version. It can change a server's services or revoke
it. Revoking invalidates the credential immediately. The server sees this on its next
check and stops using Crewly services.

## Configuration

`CREWLY_CLOUD_URL` sets the Crewly the server connects to. The default is
`https://app.crewly.space`.
