ALTER TABLE background_tasks ADD COLUMN sandbox_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE background_tasks ADD COLUMN primary_execution_env_id TEXT;

CREATE INDEX idx_background_tasks_primary_execution_env_id
  ON background_tasks(primary_execution_env_id);
