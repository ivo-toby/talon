-- Migration 014: durable lifecycle event outbox and per-handler deliveries.
--
-- The lifecycle_json_* functions are registered by the connection factory and
-- migration runner. They parse bounded JSON before any deep walk, preserve
-- escaped Unicode exactly, reject duplicate keys, and fail closed if absent.

CREATE TABLE lifecycle_events (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (event_sequence > 0),
  event_id       TEXT NOT NULL UNIQUE CHECK (typeof(event_id) = 'text' AND lifecycle_runtime_id_valid(event_id)),
  version        TEXT NOT NULL CHECK (version = 'v1'),
  type           TEXT NOT NULL CHECK (type IN ('message.persisted.v1', 'message.routed.v1', 'queue.item.enqueued.v1', 'queue.item.completed.v1', 'queue.item.failed.v1', 'queue.item.dead_lettered.v1', 'run.started.v1', 'provider.tool.started.v1', 'provider.tool.completed.v1', 'run.completed.v1', 'run.failed.v1', 'message.sent.v1', 'message.send_failed.v1', 'context.threshold_exceeded.v1', 'context.rotated.v1', 'context.observation_log_threshold_exceeded.v1', 'schedule.fired.v1')),
  aggregate_type TEXT NOT NULL CHECK (typeof(aggregate_type) = 'text' AND lifecycle_identifier_valid(aggregate_type)),
  aggregate_id   TEXT NOT NULL CHECK (typeof(aggregate_id) = 'text' AND lifecycle_runtime_id_valid(aggregate_id)),
  correlation_id TEXT NOT NULL CHECK (typeof(correlation_id) = 'text' AND lifecycle_runtime_id_valid(correlation_id)),
  causation_id   TEXT CHECK (causation_id IS NULL OR (typeof(causation_id) = 'text' AND lifecycle_runtime_id_valid(causation_id))),
  recursion_depth     INTEGER NOT NULL CHECK (typeof(recursion_depth) = 'integer' AND recursion_depth BETWEEN 0 AND 16),
  recursion_max_depth INTEGER NOT NULL CHECK (typeof(recursion_max_depth) = 'integer' AND recursion_max_depth BETWEEN 1 AND 16 AND recursion_depth <= recursion_max_depth),
  provenance     TEXT NOT NULL CHECK (typeof(provenance) = 'text' AND lifecycle_json_valid_provenance(provenance)),
  payload        TEXT NOT NULL CHECK (typeof(payload) = 'text' AND lifecycle_json_valid_payload(payload)),
  occurred_at    TEXT NOT NULL CHECK (typeof(occurred_at) = 'text' AND occurred_at GLOB '????-??-??T??:??:??.???Z' AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  created_at     INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE INDEX idx_lifecycle_events_aggregate_sequence ON lifecycle_events(aggregate_type, aggregate_id, event_sequence);
CREATE INDEX idx_lifecycle_events_correlation ON lifecycle_events(correlation_id, event_sequence);
CREATE INDEX idx_lifecycle_events_type_created ON lifecycle_events(type, created_at);

-- Conflict resolution must not turn the append-only outbox into a destructive
-- upsert. A BEFORE INSERT trigger runs before SQLite can delete the conflicted
-- row for INSERT OR REPLACE, preserving both the original event and any
-- deliveries that reference it. Check both persisted identities: event_id is
-- the external idempotency key, while event_sequence is the append-only key.
-- Before SQLite allocates an omitted INTEGER PRIMARY KEY, NEW.event_sequence
-- is its undefined-rowid sentinel (-1). Do not compare that provisional value.
-- The table's positive-sequence CHECK runs after allocation, so it permits an
-- omitted sequence but rejects every explicit non-positive sequence.
CREATE TRIGGER lifecycle_events_reject_replacements
BEFORE INSERT ON lifecycle_events
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM lifecycle_events
  WHERE event_id IS NEW.event_id
    OR (NEW.event_sequence IS NOT -1 AND event_sequence IS NEW.event_sequence)
)
BEGIN
  SELECT RAISE(ABORT, 'lifecycle events cannot be replaced');
END;

CREATE TABLE lifecycle_event_deliveries (
  event_id          TEXT NOT NULL REFERENCES lifecycle_events(event_id) ON DELETE CASCADE,
  handler_id        TEXT NOT NULL CHECK (typeof(handler_id) = 'text' AND lifecycle_identifier_valid(handler_id)),
  persona           TEXT NOT NULL CHECK (typeof(persona) = 'text' AND lifecycle_persona_valid(persona)),
  priority          INTEGER NOT NULL DEFAULT 0 CHECK (typeof(priority) = 'integer' AND priority BETWEEN -1000 AND 1000),
  handler_identity  TEXT NOT NULL CHECK (typeof(handler_identity) = 'text' AND lifecycle_json_valid_handler_identity(handler_identity, handler_id)),
  failure_policy    TEXT NOT NULL CHECK (typeof(failure_policy) = 'text' AND lifecycle_json_valid_failure_policy(failure_policy)),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'failed', 'completed', 'dead_letter')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
  max_attempts      INTEGER NOT NULL DEFAULT 3 CHECK (typeof(max_attempts) = 'integer' AND max_attempts BETWEEN 1 AND 100),
  next_retry_at     INTEGER CHECK (next_retry_at IS NULL OR (typeof(next_retry_at) = 'integer' AND next_retry_at BETWEEN -9007199254740991 AND 9007199254740991)),
  claim_token       TEXT CHECK (claim_token IS NULL OR (typeof(claim_token) = 'text' AND lifecycle_runtime_id_valid(claim_token))),
  claim_expires_at  INTEGER CHECK (claim_expires_at IS NULL OR (typeof(claim_expires_at) = 'integer' AND claim_expires_at BETWEEN -9007199254740991 AND 9007199254740991)),
  last_error        TEXT CHECK (last_error IS NULL OR (typeof(last_error) = 'text' AND lifecycle_json_valid_diagnostic(last_error))),
  completed_at      INTEGER CHECK (completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at BETWEEN -9007199254740991 AND 9007199254740991)),
  created_at        INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN -9007199254740991 AND 9007199254740991),
  updated_at        INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN -9007199254740991 AND 9007199254740991),
  CHECK (lifecycle_json_valid_delivery_contract(handler_identity, failure_policy, handler_id)),
  PRIMARY KEY (event_id, handler_id),
  CHECK (attempts <= max_attempts),
  CHECK ((status = 'pending' AND attempts = 0 AND next_retry_at IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL AND last_error IS NULL AND completed_at IS NULL) OR (status = 'claimed' AND attempts < max_attempts AND next_retry_at IS NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND last_error IS NULL AND completed_at IS NULL) OR (status = 'failed' AND attempts >= 1 AND attempts < max_attempts AND next_retry_at IS NOT NULL AND claim_token IS NULL AND claim_expires_at IS NULL AND last_error IS NOT NULL AND completed_at IS NULL) OR (status = 'completed' AND attempts < max_attempts AND claim_token IS NULL AND claim_expires_at IS NULL AND next_retry_at IS NULL AND last_error IS NULL AND completed_at IS NOT NULL) OR (status = 'dead_letter' AND attempts = max_attempts AND next_retry_at IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL AND last_error IS NOT NULL AND completed_at IS NULL))
);

CREATE INDEX idx_lifecycle_deliveries_ready ON lifecycle_event_deliveries(status, next_retry_at, priority DESC, created_at) WHERE status IN ('pending', 'failed');
CREATE INDEX idx_lifecycle_deliveries_expired_claims ON lifecycle_event_deliveries(claim_expires_at, priority DESC, created_at) WHERE status = 'claimed' AND claim_expires_at IS NOT NULL;
CREATE INDEX idx_lifecycle_deliveries_handler_status ON lifecycle_event_deliveries(handler_id, status, created_at);

-- A fan-out always begins at the canonical pending state. The transition
-- trigger below protects existing rows; this INSERT guard closes the direct
-- SQL path that could otherwise forge a terminal state at creation time.
CREATE TRIGGER lifecycle_event_deliveries_guard_initial_insert
BEFORE INSERT ON lifecycle_event_deliveries
FOR EACH ROW
WHEN NOT (
  NEW.status IS 'pending'
  AND NEW.attempts IS 0
  AND NEW.next_retry_at IS NULL
  AND NEW.claim_token IS NULL
  AND NEW.claim_expires_at IS NULL
  AND NEW.last_error IS NULL
  AND NEW.completed_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'lifecycle deliveries must be inserted pending');
END;

-- A delivery's composite event/handler key is a durable fan-out identity.
-- Abort before INSERT OR REPLACE can delete the original row and bypass the
-- immutable snapshot and transition guards that apply only to UPDATE.
CREATE TRIGGER lifecycle_event_deliveries_reject_replacements
BEFORE INSERT ON lifecycle_event_deliveries
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM lifecycle_event_deliveries
  WHERE event_id IS NEW.event_id AND handler_id IS NEW.handler_id
)
BEGIN
  SELECT RAISE(ABORT, 'lifecycle deliveries cannot be replaced');
END;

-- Events are an append-only outbox. All columns, including the generated
-- sequence, are immutable once SQLite has accepted the insert.
CREATE TRIGGER lifecycle_events_reject_updates
BEFORE UPDATE ON lifecycle_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'lifecycle events are immutable');
END;

-- Deliveries retain their event/handler identity and fan-out policy snapshot.
-- The remaining fields may change only as part of one of the durable state
-- transitions below. CHECK constraints validate each target state; this trigger
-- additionally prevents direct SQL from skipping a claim or rewriting history.
CREATE TRIGGER lifecycle_event_deliveries_guard_transitions
BEFORE UPDATE ON lifecycle_event_deliveries
FOR EACH ROW
WHEN NOT (
  NEW.event_id IS OLD.event_id
  AND NEW.handler_id IS OLD.handler_id
  AND NEW.persona IS OLD.persona
  AND NEW.priority IS OLD.priority
  AND NEW.handler_identity IS OLD.handler_identity
  AND NEW.failure_policy IS OLD.failure_policy
  AND NEW.max_attempts IS OLD.max_attempts
  AND NEW.created_at IS OLD.created_at
  AND (
    -- A ready delivery acquires exactly one fresh lease without changing its
    -- attempt count. Failed deliveries clear their retry diagnostic here.
    (
      OLD.status IN ('pending', 'failed')
      AND NEW.status = 'claimed'
      AND NEW.attempts IS OLD.attempts
      AND NEW.next_retry_at IS NULL
      AND NEW.claim_token IS NOT NULL
      AND NEW.claim_expires_at IS NOT NULL
      AND NEW.last_error IS NULL
      AND NEW.completed_at IS OLD.completed_at
    )
    OR
    -- Only a leased delivery can complete; completion does not consume a new
    -- attempt and clears the lease atomically.
    (
      OLD.status = 'claimed'
      AND NEW.status = 'completed'
      AND NEW.attempts IS OLD.attempts
      AND NEW.next_retry_at IS NULL
      AND NEW.claim_token IS NULL
      AND NEW.claim_expires_at IS NULL
      AND NEW.last_error IS NULL
      AND NEW.completed_at IS NOT NULL
    )
    OR
    -- A failed execution or expired lease consumes exactly one attempt before
    -- moving to retryable failure or the terminal dead-letter state.
    (
      OLD.status = 'claimed'
      AND NEW.status IN ('failed', 'dead_letter')
      AND NEW.attempts = OLD.attempts + 1
      AND NEW.claim_token IS NULL
      AND NEW.claim_expires_at IS NULL
      AND NEW.last_error IS NOT NULL
      AND NEW.completed_at IS OLD.completed_at
    )
    OR
    -- Explicit replay may reopen only a terminal delivery and resets every
    -- mutable execution field to the canonical pending state.
    (
      OLD.status IN ('completed', 'dead_letter')
      AND NEW.status = 'pending'
      AND NEW.attempts = 0
      AND NEW.next_retry_at IS NULL
      AND NEW.claim_token IS NULL
      AND NEW.claim_expires_at IS NULL
      AND NEW.last_error IS NULL
      AND NEW.completed_at IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid lifecycle delivery update');
END;
