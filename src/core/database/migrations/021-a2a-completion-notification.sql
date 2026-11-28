-- Completion notification policy for delegated A2A tasks (ADR 0003).
--
-- notify = 'wake' means: when the task reaches a terminal state, the daemon
-- delivers one batched message into the source thread so the delegating
-- persona is woken. 'none' never notifies. Rows that predate this column
-- stay 'none': they were never promised a notification.
--
-- notified_at records when the notification covering this task was enqueued.
-- It is only ever set from NULL, in the same transaction as the enqueue.
-- A notification is owed when the task is terminal, notify = 'wake' and
-- notified_at IS NULL, so no separate outbox table is needed.

ALTER TABLE a2a_tasks ADD COLUMN notify TEXT NOT NULL DEFAULT 'none'
  CHECK (notify IN ('wake', 'none'));

ALTER TABLE a2a_tasks ADD COLUMN notified_at INTEGER;

-- completed_at IS NOT NULL stands for "terminal" (every terminal transition sets
-- it). SQLite uses a partial index only when the query repeats its predicate, and
-- an IN (...) over state makes the planner pick idx_a2a_tasks_state instead, so
-- the owed query uses exactly these three terms.
CREATE INDEX idx_a2a_tasks_notify_owed ON a2a_tasks(completed_at)
  WHERE notify = 'wake'
    AND notified_at IS NULL
    AND completed_at IS NOT NULL;
