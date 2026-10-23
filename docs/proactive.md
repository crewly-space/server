# Proactive assistants

During a conversation, assistants use the current goal and context to carry out
the next useful step instead of waiting for another “continue”. Their tools and
existing permissions still determine what they can actually execute.

For an assistant to return to a conversation on its own, open **Scheduled tasks
→ Proactive follow-ups**. Choose the assistant, review focus, first check and a
daily or weekly interval. Save to enable it. It is off until explicitly saved.
Use **Pause** in that same list to stop it. You can create a new follow-up later.

Each review looks for unfinished work and may send a useful draft, decision or
next action. If the model has nothing useful to add, no message is posted.
Reviews may proactively consult up to two different available agents owned by
the same person when their expertise helps. Choose permitted teammates under
**Assistant settings → Can consult or hand work to**; removing them disables
consultation. The assistant also needs its permission to message other agents.
Each teammate receives only a focused task, without the original conversation
or its summary, and returns its answer to the lead. The lead posts one combined
result. The run inspector records who was consulted and the cost of the chain.

Teammates answer without tools or further delegation. Reviews cannot change
external services, create artifacts or schedule more jobs. Ask in chat to
execute a proposed action. Ordinary chat turns may also consult teammates when
that materially helps, using the existing delegation permissions and depth limit.

The lightweight server scheduler stores the settings and review claims in the
same database as conversations. No extra worker service is needed. The server
must be running; closing the browser does not stop reviews.

- At most one review attempt per 24 hours per saved follow-up, even after a
  restart or provider error. Failed attempts are not automatically retried for
  the same human message; ask in chat to continue immediately.
- Only between 08:00 and 20:00 in the time zone saved with the follow-up. That
  window follows daylight-saving changes; recurrence itself uses fixed intervals.
- Only after 30 minutes without a message, with human activity in the last
  seven days. No new human message since the previous review means no model call.
- Busy assistants, DND and disconnected providers skip the check. Checks skipped
  for activity or unavailability wait until the next scheduled interval.
- Busy, blocked, DND or unavailable teammates are not woken. Consultations use
  the same daily review claim; they cannot start an independent follow-up loop.
- Conversation membership, agent participation and blocking are rechecked before
  running and before delivery. Pausing, DND, access removal or a new message
  during the review discards the late answer.
- One enabled follow-up per assistant per conversation prevents duplicate rules.
  The person who enabled it can inspect its history and pause it.

Reviews and consultations use each assistant's configured provider and may
consume credits even when the lead chooses silence. Each review allows two
consultation rounds, at most one call to each of two teammates, then a final
answer. Provider retries and fallbacks still follow their normal limits.
The scheduler checks eligibility before calling it, so
an idle conversation does not incur repeated model requests. Model judgment
still determines whether a topic is unresolved and whether a suggestion helps.
