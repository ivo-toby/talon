CREATE TABLE workflow_items (
  id                TEXT PRIMARY KEY,
  workflow_type     TEXT NOT NULL,
  domain            TEXT NOT NULL,
  title             TEXT NOT NULL,
  goal_json         TEXT NOT NULL,
  state             TEXT NOT NULL
                    CHECK (state IN ('intake', 'ready', 'in_progress', 'awaiting_validation', 'blocked', 'escalated', 'done', 'cancelled')),
  status_reason     TEXT,
  rollout_mode      TEXT NOT NULL
                    CHECK (rollout_mode IN ('observe', 'guided', 'authoritative')),
  policy_pack       TEXT NOT NULL,
  policy_version    TEXT NOT NULL,
  owner_actor_id    TEXT,
  source_thread_id  TEXT,
  source_message_id TEXT,
  source_run_id     TEXT,
  priority          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER
);

CREATE TABLE workflow_claims (
  id                   TEXT PRIMARY KEY,
  workflow_item_id     TEXT NOT NULL,
  claim_type           TEXT NOT NULL,
  actor_id             TEXT NOT NULL,
  actor_kind           TEXT NOT NULL
                       CHECK (actor_kind IN ('persona', 'human', 'system', 'background_agent', 'tool')),
  action               TEXT NOT NULL,
  target               TEXT NOT NULL,
  asserted_outcome     TEXT NOT NULL,
  summary              TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  status               TEXT NOT NULL
                       CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  policy_decision_json TEXT,
  created_at           INTEGER NOT NULL,
  resolved_at          INTEGER,
  FOREIGN KEY (workflow_item_id) REFERENCES workflow_items(id) ON DELETE CASCADE
);

CREATE TABLE workflow_evidence (
  id              TEXT PRIMARY KEY,
  workflow_item_id TEXT NOT NULL,
  claim_id        TEXT,
  evidence_type   TEXT NOT NULL,
  source          TEXT NOT NULL,
  locator         TEXT NOT NULL,
  captured_at     INTEGER NOT NULL,
  provenance_json TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (workflow_item_id) REFERENCES workflow_items(id) ON DELETE CASCADE,
  FOREIGN KEY (claim_id) REFERENCES workflow_claims(id) ON DELETE SET NULL
);

CREATE TABLE workflow_events (
  id              TEXT PRIMARY KEY,
  workflow_item_id TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  actor_id        TEXT,
  correlation_id  TEXT,
  payload_json    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (workflow_item_id) REFERENCES workflow_items(id) ON DELETE CASCADE
);

CREATE TABLE workflow_leases (
  id              TEXT PRIMARY KEY,
  workflow_item_id TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  actor_kind      TEXT NOT NULL
                  CHECK (actor_kind IN ('persona', 'human', 'system', 'background_agent', 'tool')),
  lease_state     TEXT NOT NULL
                  CHECK (lease_state IN ('active', 'expired', 'released')),
  acquired_at     INTEGER NOT NULL,
  renewed_at      INTEGER,
  expires_at      INTEGER NOT NULL,
  released_at     INTEGER,
  FOREIGN KEY (workflow_item_id) REFERENCES workflow_items(id) ON DELETE CASCADE
);

CREATE TABLE workflow_interventions (
  id                TEXT PRIMARY KEY,
  workflow_item_id  TEXT NOT NULL,
  intervention_type TEXT NOT NULL,
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL
                    CHECK (status IN ('pending', 'applied', 'dismissed')),
  payload_json      TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  FOREIGN KEY (workflow_item_id) REFERENCES workflow_items(id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_items_type_state_updated
  ON workflow_items(workflow_type, state, updated_at);

CREATE INDEX idx_workflow_items_owner_state
  ON workflow_items(owner_actor_id, state);

CREATE INDEX idx_workflow_claims_item_status_created
  ON workflow_claims(workflow_item_id, status, created_at);

CREATE INDEX idx_workflow_evidence_item_created
  ON workflow_evidence(workflow_item_id, created_at);

CREATE INDEX idx_workflow_events_item_created
  ON workflow_events(workflow_item_id, created_at);

CREATE INDEX idx_workflow_leases_item_state_expires
  ON workflow_leases(workflow_item_id, lease_state, expires_at);

CREATE INDEX idx_workflow_interventions_item_status_created
  ON workflow_interventions(workflow_item_id, status, created_at);
