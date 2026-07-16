-- Permit a claimed non-retryable execution to terminally dead-letter after
-- its one consumed attempt, without weakening lease or immutable-row guards.

DROP TRIGGER lifecycle_event_deliveries_guard_initial_insert;
DROP TRIGGER lifecycle_event_deliveries_reject_replacements;
DROP TRIGGER lifecycle_event_deliveries_guard_transitions;

CREATE TABLE lifecycle_event_deliveries_new (
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
  CHECK ((status = 'pending' AND attempts = 0 AND next_retry_at IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL AND last_error IS NULL AND completed_at IS NULL) OR (status = 'claimed' AND attempts < max_attempts AND next_retry_at IS NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND last_error IS NULL AND completed_at IS NULL) OR (status = 'failed' AND attempts >= 1 AND attempts < max_attempts AND next_retry_at IS NOT NULL AND claim_token IS NULL AND claim_expires_at IS NULL AND last_error IS NOT NULL AND completed_at IS NULL) OR (status = 'completed' AND attempts < max_attempts AND claim_token IS NULL AND claim_expires_at IS NULL AND next_retry_at IS NULL AND last_error IS NULL AND completed_at IS NOT NULL) OR (status = 'dead_letter' AND attempts >= 1 AND attempts <= max_attempts AND next_retry_at IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL AND last_error IS NOT NULL AND completed_at IS NULL))
);

INSERT INTO lifecycle_event_deliveries_new (
  event_id, handler_id, persona, priority, handler_identity, failure_policy,
  status, attempts, max_attempts, next_retry_at, claim_token, claim_expires_at,
  last_error, completed_at, created_at, updated_at
)
SELECT
  event_id, handler_id, persona, priority, handler_identity, failure_policy,
  status, attempts, max_attempts, next_retry_at, claim_token, claim_expires_at,
  last_error, completed_at, created_at, updated_at
FROM lifecycle_event_deliveries;

DROP TABLE lifecycle_event_deliveries;
ALTER TABLE lifecycle_event_deliveries_new RENAME TO lifecycle_event_deliveries;

CREATE INDEX idx_lifecycle_deliveries_ready ON lifecycle_event_deliveries(status, next_retry_at, priority DESC, created_at) WHERE status IN ('pending', 'failed');
CREATE INDEX idx_lifecycle_deliveries_expired_claims ON lifecycle_event_deliveries(claim_expires_at, priority DESC, created_at) WHERE status = 'claimed' AND claim_expires_at IS NOT NULL;
CREATE INDEX idx_lifecycle_deliveries_handler_status ON lifecycle_event_deliveries(handler_id, status, created_at);

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
