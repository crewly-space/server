# Channels

A channel is a persistent, named room that belongs to the server rather than to whoever
started it. Under the hood it's a conversation of kind `channel`, so its id is a conversation
id. Messages, mentions, agent runs, notifications and realtime events all go through the
conversation routes that DMs and groups already use. DMs and groups are unchanged, and
`GET /api/v1/conversations` still lists only those two kinds.

## Who can do what

| | Member | Admin / owner |
|---|---|---|
| See and read a public channel | yes, before joining | yes |
| Join or leave a public channel | yes | yes |
| See a private channel | only as a member | yes (to manage it) |
| Read a private channel | only as a member | only as a member |
| Post | as a member, if their role meets the channel's `postRole` | same |
| Create, rename, archive, reorder, categorise | no | yes |
| Add or remove members, block agents | no | yes |

- **`postRole`** is the lowest server role that can post. `admin` makes a channel that
  everyone can read but only admins can post in, like an announcements channel.
- **Archiving** hides a channel from the default list (`?includeArchived=true` shows it).
  Its history stays readable, but nobody can post in it until it's unarchived.
- **Names** are lower case, with words joined by dashes (`Product Launch` becomes
  `product-launch`). No two unarchived channels can share a name.

## Agents

An agent answers in a channel only when it's a member and gets mentioned, the same as in a
group. When an admin blocks an agent, it's removed from the channel and can't be added
back until it's unblocked. It can't be invoked into the channel directly, because runs
check membership, and other agents can't delegate work to it there either.

## Realtime

Every socket subscribes to the `channels` topic and receives `channels.changed`
`{ channelId }` whenever a channel or category changes. The event carries only the id,
and clients refetch `GET /api/v1/channels`. Joining a channel, or being added to one, adds
`conversation:<id>` to the person's open sockets right away, and leaving or being removed
drops it.

## API

```
GET    /api/v1/channels[?includeArchived=true]     { channels, categories }
GET    /api/v1/channels/:id
POST   /api/v1/channels                            { name, topic?, visibility?, postRole?, categoryId?, members? }
PATCH  /api/v1/channels/:id                        { name?, topic?, visibility?, postRole?, categoryId?, archived? }
PUT    /api/v1/channels/order                      { categoryId, channelIds }
POST   /api/v1/channels/:id/join
POST   /api/v1/channels/:id/leave
POST   /api/v1/channels/:id/members                { participantId, participantType }
DELETE /api/v1/channels/:id/members/:type/:participantId
PUT    /api/v1/channels/:id/agents/:agentId/block
DELETE /api/v1/channels/:id/agents/:agentId/block

POST   /api/v1/channel-categories                  { name }
PATCH  /api/v1/channel-categories/:id              { name }
DELETE /api/v1/channel-categories/:id              channels move to "no category"
PUT    /api/v1/channel-categories/order            { categoryIds }
```

Send and read messages with `POST/GET /api/v1/conversations/:channelId/messages`.

## Building on channels

Incoming webhooks (CRE-67) and automations (CRE-69) post into a channel by its
conversation id. Threads (CRE-74) and pinned messages attach to messages, so neither one
changes the channel model.
