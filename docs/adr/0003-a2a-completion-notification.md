---
status: accepted
date: 2026-11-28
---

# Wake the delegating persona when a delegated task finishes

A delegated task (`persona_send`) stores its result in `a2a_tasks` and the run sends
nothing to any channel. A caller that did not set `await_reply` only learns the outcome by
polling `persona_task_status`, so orchestrating personas either poll (tokens, and flaky when
a timer or loop drops) or never find out. Background agents already enqueue a completion
message into the owning thread, but non-atomically: the status update and the enqueue are
separate calls and an enqueue failure is only logged.

Decision: when a delegated task reaches a terminal state, the platform delivers one
notification message into the source thread (`a2a_tasks.thread_id`), which wakes the
delegating persona once. Its reply then reaches the human through the thread's normal
channel delivery, so no chat IDs are tracked by agents.

- **Policy.** `a2a_tasks.notify` is `wake` or `none`. `persona_send` takes an optional
  `notify`; the default is `wake` when `await_reply` is false and `none` when it is true
  (the awaiting caller is already blocked on the result). An explicit `wake` together with
  `await_reply` is rejected, because the result would arrive twice. When an awaited call
  times out without cancelling, or its wait is lost to a poll error, the task is switched to
  `wake` so the late result still arrives (an explicit `notify: "none"` opts out of the
  switch). A restart of the daemon during an awaited wait cannot be recovered: the caller
  must use `persona_task_status`. A delegated persona that delegates onward cannot use
  notify wake; it must await_reply or poll, because its run is not a foreground run in the
  source thread. Such calls are always `none`; an explicit `wake` is a tool error.
  CLI-submitted tasks (`talonctl a2a send`) are `none`. Existing rows migrate to `none`.
- **Terminal states** that notify: `completed`, `failed`, `canceled`, including tasks the
  reaper fails as orphaned or cancels at `a2a.taskTtlMinutes`, and tasks an operator cancels
  with `talonctl a2a cancel`. Only the delegating persona cancelling its own task
  (`persona_task_cancel`, `cancel_on_timeout`) does not wake itself. A failure wakes the delegating
  persona, not a coordinator, because only the delegator can retry or replan.
- **Durability without an outbox table.** A notification is owed when a task is terminal,
  `notify = 'wake'` and `notified_at IS NULL`. A daemon dispatcher finds those rows, so a
  restart loses nothing and no timer owned by an agent is involved.
- **Exactly once.** Enqueueing the notification and setting `notified_at` for the covered
  tasks happen in one transaction on the same connection; `notified_at` is only set from
  NULL. A crash before commit leaves the rows owed.
- **Batching.** Owed tasks are grouped by source thread. A group is delivered when its
  oldest owed task is `a2a.notifyBatchWindowSeconds` old (default 20, range 0 to 600; a
  fixed window from the first terminal task, not a sliding one, so latency is bounded).
  Tasks finishing together produce one message and one run. One message covers at most 20
  tasks (oldest first); the rest stay owed and go out on the next tick. A thread that has no
  chat to deliver to (a CLI-created schedule thread) is not woken: its tasks are marked
  notified and logged.
- **Content.** Per task: ID, target persona, state, and a result or error excerpt of at
  most 800 characters, 4,000 in total; the message says to use `persona_task_status` for
  the full result. Excerpts are untrusted model output: each is rendered on a single line
  with line breaks replaced by ` ⏎ `, so it cannot forge a platform line. A notification is a
  queue item of type `message` with payload `kind: 'a2a_task_notification'`, not a
  `messages` row, like the background-agent completion message. It has no message ID and no
  author, so it never counts as human input, attracts no reply target and keeps the thread's
  queue order. A wake run is an ordinary run in the source thread, with the thread's
  history; it does not inherit a hop count, so loops between personas remain the
  agents' responsibility and `a2a.maxHops` still bounds each delegation chain.
- **Privacy.** For a source thread that the background-agent path classifies as voice (or
  where classification fails), the message carries only task ID and state, no excerpt,
  following `BackgroundAgentManager`. Notifier logs for such threads carry no thread or task
  identifiers.

Out of scope, recorded for later: carrying a root origin (channel, thread, trigger message)
down delegation chains with a platform-resolved `channel.send` target; moving background
agent notifications onto the same mechanism; a "stalled but not yet expired" signal (today
the TTL cancels, and the cancellation notifies).

Known limitation: a fresh session or context rotation shows the persona's reply but not the
notification text; the task results stay available through `persona_task_status`.

Consequence: orchestrating personas can dispatch work and stop; they are woken once per
batch of results, at the cost of one run per batch rather than one per poll. A persona that
delegates to itself or in a cycle can still create wake loops through its own decisions.
