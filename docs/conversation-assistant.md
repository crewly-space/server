# Conversation assistant

A native chat agent can do useful work without connectors: calculations, date arithmetic, creating files, reading attached text, and saving reminders or future agent tasks. These tools are offered through the same provider tool loop as connectors. Device-backed providers that cannot accept native tool definitions are not advertised these capabilities.

## Scheduling from chat

- `schedule_message`: save a message to this conversation for an explicit future ISO timestamp, with an optional interval in minutes.
- `schedule_task`: run this agent with the saved instructions at that time, posting its result into this conversation.
- `list_scheduled_tasks` and `cancel_scheduled_task`: inspect or disable this person's tasks for this agent and conversation.

Only a turn requested by an active human participant can create schedules. Delegated and scheduled turns cannot create further schedules. Access is checked again on delivery. A removed/suspended person or removed/blocked agent prevents execution. The UI list/cancel API is scoped to the authenticated creator and an accessible conversation, without requiring automation administration.

Schedules use the existing SQLite/PostgreSQL automation tables. The existing server timer checks once a minute; the browser can be closed, but the server must be online. A missed one-time task runs on the next tick after restart. Recurring tasks catch up once in the current slot, rather than flooding the conversation with every missed occurrence. One-time rules are disabled after their attempt. Failed attempts remain visible in run history and generate an attention notification. They are not automatically replayed: external actions may already have happened before a failure. Relative dates use `current_time` / `date_math`; an unknown timezone for a wall-clock request must be clarified.

Delivery produces a persisted conversation message and uses configured notification channels. Tool success means the task was saved, not that a future task has already completed. Models are instructed to confirm actions only from successful tool results.

## Attached text

Provider messages carry attachment metadata, including IDs. `read_attachment` reads UTF-8 text, Markdown, CSV, JSON, and SVG from an attachment actually posted in the current turn's visible conversation history. It checks conversation membership again, rejects pending/unrelated files, returns at most 50,000 characters per call, and provides `nextOffset` for paging. Binary documents and images are not OCR/extracted by this tool; the model must state that limitation or use another available tool.

## Client API

`GET /api/v1/conversations/:conversationId/scheduled-tasks` returns the signed-in person's tasks, schedule, text, enabled flag and last attempt status. `DELETE /api/v1/conversations/:conversationId/scheduled-tasks/:id` disables one of those tasks. Inaccessible conversations and other people's tasks return 404. Existing admin automation endpoints remain separate.
