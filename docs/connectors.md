# Connectors

Connectors are OAuth installations owned by the Crewly server. They are different from
AI providers and MCP servers: a connector has an account, provider scopes, health state,
per-agent capability grants and an audit log. Connecting an account does **not** grant it
to any agent.

## Built-in providers

| Provider | Server environment | Main capabilities |
| --- | --- | --- |
| GitHub | `CREWLY_GITHUB_CLIENT_ID`, `CREWLY_GITHUB_CLIENT_SECRET` | Repositories, issues, pull-request comments |
| GitLab | `CREWLY_GITLAB_CLIENT_ID`, `CREWLY_GITLAB_CLIENT_SECRET` | Projects, issues, merge-request comments |
| Linear | `CREWLY_LINEAR_CLIENT_ID`, `CREWLY_LINEAR_CLIENT_SECRET` | Issues, projects and comments |
| Asana | `CREWLY_ASANA_CLIENT_ID`, `CREWLY_ASANA_CLIENT_SECRET` | Projects, tasks and comments |
| Notion | `CREWLY_NOTION_CLIENT_ID`, `CREWLY_NOTION_CLIENT_SECRET` | Search, read, create and comment on pages |
| Google Drive | `CREWLY_GOOGLE_DRIVE_CLIENT_ID`, `CREWLY_GOOGLE_DRIVE_CLIENT_SECRET` | Search, read and create files |
| Google Calendar | `CREWLY_GOOGLE_CALENDAR_CLIENT_ID`, `CREWLY_GOOGLE_CALENDAR_CLIENT_SECRET` | Calendars; read, create, update and delete events |
| Gmail | `CREWLY_GMAIL_CLIENT_ID`, `CREWLY_GMAIL_CLIENT_SECRET` | Search, read and send email |
| Dropbox | `CREWLY_DROPBOX_CLIENT_ID`, `CREWLY_DROPBOX_CLIENT_SECRET` | Search, read and upload files |
| Slack | `CREWLY_SLACK_CLIENT_ID`, `CREWLY_SLACK_CLIENT_SECRET` | Channels, messages and QuickStart import |

Register the exact Crewly app callback URL with each provider. The web app sends its own
origin as the callback and the server accepts only same-origin or explicitly trusted app
origins.

OAuth tokens are encrypted at rest and never returned by the API. After connecting, use
the connector grants API or the agent settings UI to grant individual capabilities. Reads
require `network.access`; writes also require `external.side_effect`, so an agent policy
can allow, ask for approval, or deny the exact call.

The generic OAuth endpoints are:

```text
POST /api/v1/connectors/oauth/:provider/start
POST /api/v1/connectors/oauth/:provider/complete
```

The original provider-specific SDK methods remain available and call these endpoints.

`GET /api/v1/connectors/providers` reports, per provider, whether this server is
`configured` for it and, under `setup`, the two environment variables and the page where
the OAuth app is registered, so the app can show an admin what to do instead of a failed
Connect. Starting a sign-in for an unconfigured provider answers `503` with the same
explanation in `message` and the unset variables in `missing`.

To reconnect a disconnected or broken connector, pass its `connectorId` to `start`. The
sign-in then updates that connector, keeping its grants and audit history; a disconnected
connector offers agents no tools until it is connected again.
