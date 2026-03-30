CREATE TABLE IF NOT EXISTS rate_limit_events (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sender_id  TEXT,
  event_type TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rle_channel_ts ON rate_limit_events(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_rle_sender_ts  ON rate_limit_events(sender_id, ts);

CREATE TABLE IF NOT EXISTS governance_violations (
  id           TEXT PRIMARY KEY,
  persona_id   TEXT,
  thread_id    TEXT,
  run_id       TEXT,
  violation    TEXT NOT NULL,
  detail       TEXT,
  action_taken TEXT NOT NULL,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gv_persona_ts ON governance_violations(persona_id, ts);
