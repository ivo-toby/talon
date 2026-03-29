-- ============================================================
-- A2A TASKS
-- Tracks Agent2Agent task lifecycle for persona-to-persona
-- collaboration using the A2A protocol.
-- ============================================================

CREATE TABLE a2a_tasks (
  id              TEXT PRIMARY KEY,
  source_persona  TEXT NOT NULL,
  target_persona  TEXT NOT NULL,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  queue_item_id   TEXT REFERENCES queue_items(id),
  run_id          TEXT REFERENCES runs(id),
  state           TEXT NOT NULL
                  CHECK (state IN ('submitted', 'working', 'input-required', 'completed', 'failed', 'canceled')),
  request_payload TEXT NOT NULL,  -- JSON: A2ATaskPayload
  result_payload  TEXT,           -- JSON: { text: string } on completion
  error_code      TEXT,
  error_message   TEXT,
  hop_count       INTEGER NOT NULL DEFAULT 0,
  parent_task_id  TEXT REFERENCES a2a_tasks(id),
  submitted_at    INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);

CREATE INDEX idx_a2a_tasks_thread ON a2a_tasks(thread_id, submitted_at DESC);
CREATE INDEX idx_a2a_tasks_state ON a2a_tasks(state, updated_at DESC);
CREATE INDEX idx_a2a_tasks_target ON a2a_tasks(target_persona, state, submitted_at DESC);
