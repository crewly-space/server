# Notifications

Everything Crewly tells people about goes through one pipeline. Feature code emits a
normalised event with `emitNotification(db, event)`: what happened, who should know, and a
dedupe key. It never sends mail or writes an in-app notification itself.

## Events

| Event | Sent to | Channels (default) | Can be turned off |
|---|---|---|---|
| `member.invited` | The invited address | email | No (account) |
| `auth.magic_link` | The address signing in | email | No (security) |
| `mention.created` | People mentioned in a message | in-app, email | Yes |
| `dm.created` | The other person in a DM | in-app (email off) | Yes |
| `agent.needs_attention` | People in the conversation where a run failed | in-app, email | Yes |
| `agent.completed` | People in the conversation where an agent replied | in-app (email off) | Yes |
| `server.alert` | Owners and admins (background work out of retries) | in-app, email | Yes |
| `billing.warning` | Owners and admins (a budget threshold reached) | in-app, email | Yes |

## Policy

For each recipient and channel the decision is, in order:

1. A mandatory event is always sent.
2. The person's own choice for that event and channel (`instant` or `off`).
3. The default in the table above.

The same inputs always give the same answer. In-app and email are decided separately, but
from the same policy.

- **Retries are idempotent.** An event emitted again with the same dedupe key notifies nobody
  a second time.
- **Bursts collapse.** Events that share a collapse key (by default, their conversation) for
  one person and channel within 60 seconds produce a single notification.

## Digests

Any event that isn't mandatory can be set to `digest` for email. Its email then waits for
the person's next scheduled digest instead of going out at once. In-app notifications are
still immediate. The schedule is daily or weekly at a chosen hour (UTC). The default is
daily at 08:00 (`GET/PUT /api/v1/notifications/digest` `{frequency, hourUtc, weekday?}`).

- **One email.** When the time comes, everything that was waiting goes out as a single
  email through the mail gateway. Repeats of one kind about the same thing become one line
  ("… and 2 more like it"). Each line links back to its conversation.
- **Once per slot.** Each scheduled time is sent at most once. Events that arrive after it
  wait for the next one.
- **Changed preferences.** When the digest goes out, a waiting event whose email the person
  has since turned off is dropped. One they've since made instant still comes in this digest,
  because it was already waiting.
- **Never delayed.** Mandatory events can't be put in a digest, and neither can in-app
  delivery. Events set to instant are never held.
- **Failures.** A failed digest follows the mail gateway's retry policy, and the events in it
  are settled from the outcome.

## Delivery

- **In-app** notifications are stored and pushed live as `notification.created` on
  `user:<id>`. A failed write is retried up to 3 times.
- **Email** goes only through the [mail gateway](mail.md) and follows its retry policy. When
  mail is disabled, the email is recorded as skipped and the in-app notification still arrives.
  When the server receives mail, replying to a notification email posts in the conversation.
- Set `CREWLY_PUBLIC_URL` to the address people reach the server at. Notification emails then
  link back to the conversation (`/?conversation=<id>`).

Channels implement one interface (`NotificationChannel`), so push or webhooks can be added
without touching any emitter.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/v1/notifications` | `?unread=true&limit=`. The feed and the unread count. |
| POST | `/api/v1/notifications/:id/read` | |
| POST | `/api/v1/notifications/read-all` | |
| GET | `/api/v1/notifications/preferences` | Every event, whether it's mandatory, and the mode per channel. |
| PUT | `/api/v1/notifications/preferences` | `{type, channel, mode}` with mode `instant`, `off` or (email only) `digest`. Mandatory events return 400. |
| GET/PUT | `/api/v1/notifications/digest` | The digest schedule. |
| GET | `/api/v1/server/notifications/deliveries` | Owners and admins. `?status=`, including failures and their errors. |
