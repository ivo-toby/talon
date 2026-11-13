-- Durable browservoice login authority.
-- Session and CSRF values are represented only by one-way verification hashes.

CREATE TABLE voice_auth_binding (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id              TEXT NOT NULL,
  credential_salt       TEXT NOT NULL,
  credential_verifier   TEXT NOT NULL,
  binding_revision      INTEGER NOT NULL CHECK (binding_revision > 0),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE voice_auth_revision_allocator (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  next_revision   INTEGER NOT NULL CHECK (next_revision > 0)
);

INSERT INTO voice_auth_revision_allocator (id, next_revision)
SELECT 1, COALESCE(MAX(login_revision), 0) + 1
FROM voice_sessions;

CREATE TABLE voice_auth_sessions (
  id                  TEXT PRIMARY KEY,
  session_token_hash  TEXT NOT NULL UNIQUE,
  csrf_token_hash     TEXT NOT NULL,
  owner_id            TEXT NOT NULL,
  login_revision      INTEGER NOT NULL UNIQUE,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  revoked_at          INTEGER
);

CREATE INDEX idx_voice_auth_sessions_active
  ON voice_auth_sessions(owner_id, expires_at, revoked_at);
CREATE INDEX idx_voice_auth_sessions_expiry
  ON voice_auth_sessions(expires_at, revoked_at);
