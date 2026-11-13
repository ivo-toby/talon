-- ============================================================
-- BROWSERVOICE PERSISTENCE
-- Durable session, delegation, and output state. Transcript/audio
-- transport data is deliberately not represented as a durable column.
-- ============================================================

CREATE TABLE voice_sessions (
  id                   TEXT PRIMARY KEY,
  revision             INTEGER NOT NULL,
  owner_id             TEXT NOT NULL,
  login_revision       INTEGER NOT NULL,
  persona_id           TEXT NOT NULL,
  thread_id            TEXT NOT NULL,
  transport            TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
    'created', 'connecting', 'connected', 'closing', 'closed', 'expired', 'failed'
  )),
  provider_session_id  TEXT,
  created_at           INTEGER NOT NULL,
  started_at           INTEGER,
  deadline_at          INTEGER NOT NULL,
  closing_at           INTEGER,
  closed_at            INTEGER,
  policy_json          TEXT NOT NULL,
  usage_json           TEXT NOT NULL,
  finalization_json    TEXT NOT NULL,
  active_delegation_id TEXT,
  record_digest        TEXT NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_voice_sessions_provider_id
  ON voice_sessions(provider_session_id)
  WHERE provider_session_id IS NOT NULL;
CREATE INDEX idx_voice_sessions_owner_status
  ON voice_sessions(owner_id, status, updated_at DESC);
CREATE INDEX idx_voice_sessions_recovery
  ON voice_sessions(status, updated_at);

CREATE TABLE voice_delegations (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  provider_delegation_id   TEXT NOT NULL,
  revision                 INTEGER NOT NULL,
  context_version          INTEGER NOT NULL,
  context_digest           TEXT NOT NULL,
  request_json             TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN (
    'admitted', 'queued', 'claimed', 'running', 'completed', 'failed',
    'unknown', 'superseded', 'skipped'
  )),
  execution_status         TEXT NOT NULL CHECK (execution_status IN (
    'not_started', 'running', 'succeeded', 'failed', 'unknown', 'skipped'
  )),
  delivery_status          TEXT NOT NULL CHECK (delivery_status IN (
    'not_requested', 'pending', 'sent', 'acknowledged', 'failed', 'unknown'
  )),
  provider_ack_status      TEXT NOT NULL CHECK (provider_ack_status IN (
    'not_sent', 'sent', 'acknowledged', 'rejected', 'unknown'
  )),
  playback_status          TEXT NOT NULL CHECK (playback_status IN (
    'not_started', 'playing', 'played', 'interrupted', 'unknown'
  )),
  queue_item_id            TEXT,
  run_id                   TEXT,
  supersedes_delegation_id TEXT REFERENCES voice_delegations(id),
  latest_output_id         TEXT,
  error_code               TEXT,
  created_at               INTEGER NOT NULL,
  claimed_at               INTEGER,
  completed_at             INTEGER,
  updated_at               INTEGER NOT NULL,
  record_digest            TEXT NOT NULL,
  UNIQUE (session_id, provider_delegation_id)
);

CREATE INDEX idx_voice_delegations_session
  ON voice_delegations(session_id, created_at ASC);
CREATE INDEX idx_voice_delegations_queue
  ON voice_delegations(queue_item_id);
CREATE INDEX idx_voice_delegations_run
  ON voice_delegations(run_id);
CREATE INDEX idx_voice_delegations_status
  ON voice_delegations(status, updated_at);

CREATE TABLE voice_outputs (
  id                  TEXT PRIMARY KEY,
  delegation_id       TEXT NOT NULL REFERENCES voice_delegations(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('progress', 'final')),
  text                TEXT,
  execution_status    TEXT NOT NULL CHECK (execution_status IN (
    'not_started', 'running', 'succeeded', 'failed', 'unknown', 'skipped'
  )),
  delivery_status     TEXT NOT NULL CHECK (delivery_status IN (
    'not_requested', 'pending', 'sent', 'acknowledged', 'failed', 'unknown'
  )),
  provider_ack_status TEXT NOT NULL CHECK (provider_ack_status IN (
    'not_sent', 'sent', 'acknowledged', 'rejected', 'unknown'
  )),
  playback_status     TEXT NOT NULL CHECK (playback_status IN (
    'not_started', 'playing', 'played', 'interrupted', 'unknown'
  )),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  record_digest       TEXT NOT NULL
);

CREATE INDEX idx_voice_outputs_delegation
  ON voice_outputs(delegation_id, created_at ASC);
