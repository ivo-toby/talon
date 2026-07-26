-- Migration 019: lifecycle retention, privacy tombstoning, and disablement transitions.
--
-- Event and delivery identities remain immutable. This migration adds only the
-- guarded update paths needed to remove retained payload/detail data and to
-- invalidate pending handler work during privacy deletion or operator
-- disablement.

DROP TRIGGER lifecycle_events_reject_updates;
DROP TRIGGER lifecycle_event_deliveries_guard_transitions;

ALTER TABLE lifecycle_events
ADD COLUMN retention_tombstone_reason TEXT
  CHECK (
    retention_tombstone_reason IS NULL
    OR retention_tombstone_reason IN ('retention-compacted', 'privacy-deleted')
  );

ALTER TABLE lifecycle_event_deliveries
ADD COLUMN terminal_tombstone_reason TEXT
  CHECK (
    terminal_tombstone_reason IS NULL
    OR terminal_tombstone_reason IN ('handler-disabled', 'privacy-deleted')
  );

CREATE TRIGGER lifecycle_events_guard_initial_retention_tombstone
BEFORE INSERT ON lifecycle_events
FOR EACH ROW
WHEN NEW.retention_tombstone_reason IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'lifecycle event tombstones are system-owned');
END;

CREATE TRIGGER lifecycle_event_deliveries_guard_initial_terminal_tombstone
BEFORE INSERT ON lifecycle_event_deliveries
FOR EACH ROW
WHEN NEW.terminal_tombstone_reason IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'lifecycle delivery tombstones are system-owned');
END;

CREATE TRIGGER lifecycle_events_guard_retention_updates
BEFORE UPDATE ON lifecycle_events
FOR EACH ROW
WHEN NOT (
  NEW.event_sequence IS OLD.event_sequence
  AND NEW.event_id IS OLD.event_id
  AND NEW.version IS OLD.version
  AND NEW.type IS OLD.type
  AND NEW.aggregate_type IS OLD.aggregate_type
  AND NEW.aggregate_id IS OLD.aggregate_id
  AND NEW.correlation_id IS OLD.correlation_id
  AND (
    (NEW.causation_id IS NULL AND OLD.causation_id IS NULL)
    OR NEW.causation_id IS OLD.causation_id
  )
  AND NEW.recursion_depth IS OLD.recursion_depth
  AND NEW.recursion_max_depth IS OLD.recursion_max_depth
  AND NEW.occurred_at IS OLD.occurred_at
  AND NEW.created_at IS OLD.created_at
  AND (
    (
      NEW.payload IS OLD.payload
      AND NEW.provenance IS OLD.provenance
      AND NEW.retention_tombstone_reason IS OLD.retention_tombstone_reason
    )
    OR (
      lifecycle_retention_mutation_authorized() = 1
      AND
      NEW.payload IN (
        '{"references":[],"metadata":{"lifecycleRetention":"retention-compacted"}}',
        '{"references":[],"metadata":{"lifecycleRetention":"privacy-deleted"}}'
      )
      AND NEW.provenance IS '{"source":"retention-service","sourceEventIds":[],"sourceReferences":[]}'
      AND NEW.retention_tombstone_reason IN ('retention-compacted', 'privacy-deleted')
      AND json_extract(NEW.payload, '$.metadata.lifecycleRetention') IS NEW.retention_tombstone_reason
      AND (
        OLD.retention_tombstone_reason IS NULL
        OR NEW.retention_tombstone_reason IS 'privacy-deleted'
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid lifecycle event retention update');
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
      AND NEW.terminal_tombstone_reason IS OLD.terminal_tombstone_reason
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
      AND NEW.terminal_tombstone_reason IS OLD.terminal_tombstone_reason
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
      AND NEW.terminal_tombstone_reason IS OLD.terminal_tombstone_reason
      AND NEW.completed_at IS OLD.completed_at
    )
    OR
    (
      OLD.status IN ('completed', 'dead_letter')
      AND NEW.status = 'pending'
      AND lifecycle_retention_mutation_authorized() = 1
      AND OLD.terminal_tombstone_reason IS NULL
      AND NEW.attempts = 0
      AND NEW.next_retry_at IS NULL
      AND NEW.claim_token IS NULL
      AND NEW.claim_expires_at IS NULL
      AND NEW.last_error IS NULL
      AND NEW.terminal_tombstone_reason IS NULL
      AND NEW.completed_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM lifecycle_events target_event
        WHERE target_event.event_id = OLD.event_id
          AND target_event.retention_tombstone_reason IS NOT NULL
      )
    )
    OR
    (
      OLD.status IN ('pending', 'failed', 'claimed')
      AND NEW.status = 'dead_letter'
      AND lifecycle_retention_mutation_authorized() = 1
      AND NEW.attempts BETWEEN 1 AND OLD.max_attempts
      AND NEW.next_retry_at IS NULL
      AND NEW.claim_token IS NULL
      AND NEW.claim_expires_at IS NULL
      AND NEW.last_error IN ('{"code":"handler-disabled"}', '{"code":"privacy-deleted"}')
      AND NEW.terminal_tombstone_reason IN ('handler-disabled', 'privacy-deleted')
      AND json_extract(NEW.last_error, '$.code') IS NEW.terminal_tombstone_reason
      AND NEW.completed_at IS OLD.completed_at
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid lifecycle delivery update');
END;
