ALTER TABLE runs ADD COLUMN model_name TEXT;

CREATE INDEX idx_runs_thread_provider_model_session
  ON runs(thread_id, provider_name, model_name, created_at)
  WHERE session_id IS NOT NULL;
