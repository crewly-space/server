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
Reviews are text-only: they cannot use tools, change external services, schedule
more jobs or delegate to other agents. Ask in chat to execute a proposed action.

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
- Conversation membership, agent participation and blocking are rechecked before
  running and before delivery. Pausing, DND, access removal or a new message
  during the review discards the late answer.
- One enabled follow-up per assistant per conversation prevents duplicate rules.
  The person who enabled it can inspect its history and pause it.

Reviews use the configured model provider and may consume credits even when the
model chooses silence. The scheduler checks eligibility before calling it, so
an idle conversation does not incur repeated model requests. Model judgment
still determines whether a topic is unresolved and whether a suggestion helps.
