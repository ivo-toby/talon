-- Migration 016: durable handoff boundary for handler-emitted lifecycle signals.
--
-- Signals are not lifecycle events: they retain their typed signal contract and
-- are consumed by signal handlers/projectors through this append-only outbox.

CREATE TABLE lifecycle_signal_handoffs (
  idempotency_key TEXT PRIMARY KEY CHECK (typeof(idempotency_key) = 'text' AND lifecycle_runtime_id_valid(idempotency_key)),
  event_id        TEXT NOT NULL REFERENCES lifecycle_events(event_id) ON DELETE CASCADE,
  handler_id      TEXT NOT NULL CHECK (typeof(handler_id) = 'text' AND lifecycle_identifier_valid(handler_id)),
  persona         TEXT NOT NULL CHECK (typeof(persona) = 'text' AND lifecycle_persona_valid(persona)),
  created_at      INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN -9007199254740991 AND 9007199254740991),
  UNIQUE (event_id, handler_id, idempotency_key)
);

CREATE TABLE lifecycle_signals (
  signal_id       TEXT PRIMARY KEY CHECK (typeof(signal_id) = 'text' AND lifecycle_runtime_id_valid(signal_id)),
  handoff_key     TEXT NOT NULL REFERENCES lifecycle_signal_handoffs(idempotency_key) ON DELETE CASCADE,
  persona         TEXT NOT NULL CHECK (typeof(persona) = 'text' AND lifecycle_persona_valid(persona)),
  version         TEXT NOT NULL CHECK (version = 'v1'),
  type            TEXT NOT NULL CHECK (typeof(type) = 'text' AND lifecycle_identifier_valid(type)),
  context         TEXT NOT NULL CHECK (typeof(context) = 'text' AND json_valid(context)),
  payload         TEXT NOT NULL CHECK (typeof(payload) = 'text' AND lifecycle_json_valid_payload(payload)),
  occurred_at     TEXT NOT NULL CHECK (typeof(occurred_at) = 'text' AND occurred_at GLOB '????-??-??T??:??:??.???Z' AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  created_at      INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN -9007199254740991 AND 9007199254740991)
);

CREATE INDEX idx_lifecycle_signals_persona_created ON lifecycle_signals(persona, created_at);
CREATE INDEX idx_lifecycle_signals_type_created ON lifecycle_signals(type, created_at);
