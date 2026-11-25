-- Stored scripts: small programs that belong to a persona.
--
-- A script has numbered versions. Each version carries a content hash and one
-- of six states. A user approves a version with a one-time code; only a hash of
-- the code is stored. Every run of a version is recorded.
--
-- script_versions.thread_id and script_runs.schedule_id have no foreign key on
-- purpose: a thread or a schedule can be deleted while the history stays.

CREATE TABLE scripts (
  id          TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (persona_id, name)
);

CREATE TABLE script_versions (
  id              TEXT PRIMARY KEY,
  script_id       TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  manifest        TEXT NOT NULL,               -- JSON
  state           TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'tested', 'awaiting-approval', 'approved', 'rejected', 'retired')),
  thread_id       TEXT,
  dry_run_report  TEXT,                        -- JSON, null until a dry run finished
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (script_id, version)
);

CREATE INDEX idx_script_versions_script_state ON script_versions(script_id, state);

CREATE TABLE script_approvals (
  id                  TEXT PRIMARY KEY,
  version_id          TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
  code_hash           TEXT NOT NULL UNIQUE,
  channel_name        TEXT NOT NULL,
  external_thread_id  TEXT NOT NULL,
  expires_at          INTEGER NOT NULL,
  decided_at          INTEGER,
  decision            TEXT CHECK (decision IN ('approved', 'rejected')),
  created_at          INTEGER NOT NULL
);

CREATE INDEX idx_script_approvals_version ON script_approvals(version_id);

CREATE TABLE script_runs (
  id          TEXT PRIMARY KEY,
  version_id  TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL,
  trigger     TEXT NOT NULL CHECK (trigger IN ('test', 'dry-run', 'schedule')),
  schedule_id TEXT,
  ok          INTEGER,
  error_code  TEXT,
  call_count  INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE INDEX idx_script_runs_version_ended ON script_runs(version_id, ended_at);
