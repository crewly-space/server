# Conversation scheduling and agent behavior

Native chat turns now receive four bounded tools when a human has access to the conversation and the agent is a participant:

- `schedule_message`: save a message or reminder for later delivery here.
- `schedule_task`: invoke the current agent later with the saved instructions and post its result here.
- `list_scheduled_tasks`: show this human's schedules for this agent and conversation.
- `cancel_scheduled_task`: disable one of those schedules.

The tools do not require an external calendar. They store ordinary automation rules in the existing database and use the server's existing minute timer. The app can be closed; the server must remain running. One-time tasks missed during downtime run on the next tick, and recurring tasks run the current due slot rather than replaying every missed interval. Persisted run keys prevent duplicate execution on later ticks and after restart. An execution interrupted by a server crash is retained as a running entry and is not automatically retried, to avoid repeating an external side effect.

`runAt` is an ISO timestamp with an explicit UTC offset. Omit `intervalMinutes` for a one-time task, or supply 1–10080 minutes for recurrence measured as elapsed time. This is not a cron/calendar scheduler: a 1440-minute interval does not preserve local clock time across daylight-saving changes. Existing interval-only rules retain their original cadence and deduplication keys.

Schedules created from chat are scoped to the requesting human, current conversation, and current agent. They cannot target a different user, agent, conversation, or webhook. Access and user suspension are checked both when a tool runs and before delivery. Delegated turns and turns started by an automation do not receive the scheduling tools. Device-backed providers that cannot accept server tools retain that limitation.

Messages publish the normal conversation event and notify according to the user's existing notification settings. Future agent runs use the normal runtime and completion notifications. Failed chat schedules emit an attention notification and remain visible in automation run history. Notifications are currently in-app/email; this change does not add native mobile push.

Schedule ticks and incoming webhook requests target exactly one automation. Message/run triggers still evaluate all matching rules. A webhook secret therefore cannot cause an unrelated rule's actions to execute.

Shared behavior instructions tell every responder to keep the human's language, resolve short follow-ups from context, execute available tools before giving generic advice, discover lazy tools before declaring a capability unavailable, and confirm future work only after it is saved. Capability grounding remains authoritative; these instructions cannot make an unsupported model or disconnected connector work. Model quality still needs evaluation with a real configured provider.
