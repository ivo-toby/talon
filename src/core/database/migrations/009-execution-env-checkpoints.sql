CREATE TABLE execution_env_checkpoints (
  id          TEXT PRIMARY KEY,
  env_id      TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT 'sprites',
  remote_ref  TEXT NOT NULL,
  label       TEXT,
  status      TEXT NOT NULL
              CHECK (status IN ('creating', 'ready', 'failed')),
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_execution_env_checkpoints_env_created
  ON execution_env_checkpoints(env_id, created_at DESC);
