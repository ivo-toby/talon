ALTER TABLE runs ADD COLUMN reasoning_effort TEXT;

CREATE INDEX idx_runs_thread_provider_model_effort_session
  ON runs(thread_id, provider_name, model_name, reasoning_effort, created_at)
  WHERE session_id IS NOT NULL;
