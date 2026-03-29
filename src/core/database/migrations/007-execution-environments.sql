CREATE TABLE execution_environments (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL DEFAULT 'sprites',
  sprite_id         TEXT NOT NULL UNIQUE,
  thread_id         TEXT NOT NULL,
  persona_id        TEXT NOT NULL,
  owner_task_id     TEXT,
  status            TEXT NOT NULL
                    CHECK (status IN ('creating', 'ready', 'busy', 'checkpointing', 'restoring', 'destroying', 'destroyed', 'failed')),
  working_directory TEXT NOT NULL,
  base_snapshot     TEXT,
  auto_destroy      INTEGER NOT NULL DEFAULT 1,
  cpus              REAL NOT NULL,
  memory_mb         INTEGER NOT NULL,
  disk_gb           INTEGER NOT NULL,
  metadata_json     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  destroyed_at      INTEGER
);

CREATE INDEX idx_execution_env_thread_created
  ON execution_environments(thread_id, created_at DESC);

CREATE INDEX idx_execution_env_owner_task
  ON execution_environments(owner_task_id);
