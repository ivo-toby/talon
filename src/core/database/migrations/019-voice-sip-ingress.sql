-- ============================================================
-- AUTHENTICATED INCOMING SIP INGRESS
--
-- These rows are replay-protection and decision ownership records. Raw
-- webhook bodies, SIP headers, signing secrets, and reusable proofs are not
-- represented in the schema.
-- ============================================================

CREATE TABLE voice_sip_call_decisions (
  call_id              TEXT PRIMARY KEY
    CHECK (length(CAST(call_id AS BLOB)) BETWEEN 1 AND 256),
  provider_session_id  TEXT NOT NULL UNIQUE
    CHECK (length(CAST(provider_session_id AS BLOB)) BETWEEN 1 AND 256),
  state                TEXT NOT NULL CHECK (state IN (
    'reserved', 'attempted', 'accepted', 'rejected', 'closed', 'unknown'
  )),
  grant_revision       INTEGER NOT NULL UNIQUE CHECK (grant_revision > 0),
  event_created_at     INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  attempt_marker       TEXT
    CHECK (attempt_marker IS NULL OR length(CAST(attempt_marker AS BLOB)) BETWEEN 1 AND 256),
  attempted_at         INTEGER,
  terminal_at          INTEGER,
  metadata_json        TEXT NOT NULL
    CHECK (length(CAST(metadata_json AS BLOB)) <= 4096)
);

CREATE INDEX idx_voice_sip_call_decisions_state
  ON voice_sip_call_decisions(state, terminal_at, event_created_at);
CREATE INDEX idx_voice_sip_call_decisions_provider
  ON voice_sip_call_decisions(provider_session_id);

CREATE TABLE voice_sip_authority_grants (
  revision             INTEGER PRIMARY KEY CHECK (revision > 0),
  call_id              TEXT NOT NULL UNIQUE
    REFERENCES voice_sip_call_decisions(call_id) ON DELETE CASCADE,
  provider_session_id  TEXT NOT NULL UNIQUE
    REFERENCES voice_sip_call_decisions(provider_session_id) ON DELETE CASCADE,
  issuer               TEXT NOT NULL
    CHECK (length(CAST(issuer AS BLOB)) BETWEEN 1 AND 256),
  key_id               TEXT NOT NULL
    CHECK (length(CAST(key_id AS BLOB)) BETWEEN 1 AND 256),
  audience             TEXT NOT NULL
    CHECK (length(CAST(audience AS BLOB)) BETWEEN 1 AND 256),
  subject              TEXT NOT NULL
    CHECK (length(CAST(subject AS BLOB)) BETWEEN 1 AND 256),
  owner_id             TEXT NOT NULL
    CHECK (length(CAST(owner_id AS BLOB)) BETWEEN 1 AND 256),
  persona_id           TEXT NOT NULL
    CHECK (length(CAST(persona_id AS BLOB)) BETWEEN 1 AND 256),
  nonce                TEXT NOT NULL UNIQUE
    CHECK (length(CAST(nonce AS BLOB)) BETWEEN 1 AND 256),
  call_binding         TEXT NOT NULL
    CHECK (length(CAST(call_binding AS BLOB)) BETWEEN 1 AND 256),
  proof_hash           TEXT NOT NULL
    CHECK (length(CAST(proof_hash AS BLOB)) BETWEEN 1 AND 256),
  issued_at            INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  revoked_at           INTEGER,
  metadata_json        TEXT NOT NULL
    CHECK (length(CAST(metadata_json AS BLOB)) <= 4096),
  created_at           INTEGER NOT NULL
);

CREATE INDEX idx_voice_sip_authority_grants_expiry
  ON voice_sip_authority_grants(expires_at, revoked_at, created_at);

CREATE TABLE voice_sip_delivery_receipts (
  delivery_id          TEXT PRIMARY KEY
    CHECK (length(CAST(delivery_id AS BLOB)) BETWEEN 1 AND 256),
  call_id              TEXT NOT NULL
    REFERENCES voice_sip_call_decisions(call_id) ON DELETE CASCADE,
  provider_session_id  TEXT NOT NULL
    CHECK (length(CAST(provider_session_id AS BLOB)) BETWEEN 1 AND 256),
  state                TEXT NOT NULL CHECK (state IN (
    'reserved', 'attempted', 'accepted', 'rejected', 'closed', 'unknown'
  )),
  event_created_at     INTEGER NOT NULL,
  delivery_timestamp   INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  metadata_json        TEXT NOT NULL
    CHECK (length(CAST(metadata_json AS BLOB)) <= 1024)
);

CREATE INDEX idx_voice_sip_delivery_receipts_call
  ON voice_sip_delivery_receipts(call_id, created_at);
CREATE INDEX idx_voice_sip_delivery_receipts_provider
  ON voice_sip_delivery_receipts(provider_session_id);
