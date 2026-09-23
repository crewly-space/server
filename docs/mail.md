# Mail

All outbound email goes through one mail service, including invites, sign-in links and
notifications. Feature code names a template (or supplies bounded content of its own) and
never learns which provider is configured. Switching providers doesn't require changing
any feature code.

## Providers

| Provider | What it is | Needs |
|---|---|---|
| `disabled` | The default. Mail-dependent actions say that mail is off. | Nothing |
| `crewly` | Crewly Mail: managed delivery, metered to your Crewly account. | A [Crewly connection](crewly-connection.md) with the `mail:send` capability. |
| `smtp` | Any SMTP relay, over implicit TLS (465), STARTTLS (587) or plain for local relays. `AUTH PLAIN`. | Host, port, security, from address; username and password if the relay requires them. |
| `resend` | Resend's HTTP API. | API key and a from address on a domain verified with Resend. |
| `postmark` | Postmark's HTTP API. | Server token and a from address on a verified sender signature. |

The password or API key is encrypted with the server's secret key (see [secrets](secrets.md)).
It's never returned by the API, never sent to a browser, and never kept in plain configuration.
Switching to another provider discards the old key. SMTP, Resend and Postmark all work without
a Crewly account.

## Delivery and retries

Every message is recorded as a delivery with its provider, status, attempts, error class,
last error and provider message id. Every provider's failures map to the same error classes:

- **Retried:** `network`, `rate_limited`, `provider_unavailable`.
- **Not retried:** `auth`, `rejected`, `not_permitted`, `config`. These need a person to fix
  the cause, then retry the delivery by hand.

A retryable failure is tried again after 1 minute, 5 minutes, 30 minutes and 2 hours. That's
five attempts in all, after which the delivery is `failed`. The message body may contain a
sign-in link, so it's stored encrypted and dropped once the message is sent. Finished
deliveries are pruned after 30 days.

A send with an idempotency key returns the first delivery instead of sending the message again.

## API

All routes require an owner or admin.

| Method | Path | |
|---|---|---|
| GET | `/api/v1/server/mail` | Settings (no secret), providers, whether Crewly Mail is available, retry policy. |
| PUT | `/api/v1/server/mail` | `{provider, fromAddress?, config?, secret?}`. Omit `secret` to keep the stored one. |
| POST | `/api/v1/server/mail/test` | `{to}`. Sends a test message and returns the delivery. |
| GET | `/api/v1/server/mail/deliveries` | `?status=&limit=` |
| POST | `/api/v1/server/mail/deliveries/:id/retry` | Retries a failed or retrying delivery now. |
| GET | `/api/v1/server/mail/usage` | This month's Crewly Mail usage, when connected with `mail:send`. |

`POST /api/v1/invites` accepts an optional `email`. The invite is then also sent through the
configured provider, and the response includes the delivery.

## Custom sending domains (Crewly Mail)

Crewly Mail sends from the shared Crewly address until you verify a domain of your own:

1. Add the domain (`POST /api/v1/server/mail/domains` `{domain}`). Crewly returns the DNS records
   its mail provider needs, such as DKIM, SPF and the return path.
2. Add those records at your DNS host, then check (`POST /api/v1/server/mail/domains/:id/check`).
   If a record is still missing, the check names it. Crewly also rechecks pending domains in the
   background.
3. Once the domain is verified, Crewly Mail sends from its first allowed sender. Set the allowed
   senders with `PUT /api/v1/server/mail/domains/:id/senders` `{senders: [{localPart, name?}]}`.
   A `From` that isn't on the list, or on a domain that isn't verified, is refused.

Removing a domain (`DELETE /api/v1/server/mail/domains/:id`) stops Crewly Mail from sending from it
immediately. A domain belongs to one server at a time: to move it, remove it first, from the server
or from the account's **Connected servers** page in Crewly. Custom domains apply only to Crewly Mail.
SMTP, Resend and Postmark configured on the server are unaffected.
