-- Migration 018: persona-scoped behavior evidence and governed promotion ledger.
--
-- This is storage only. Detectors, reducers, prompt writes, reload, and UI are
-- later tasks. Rows keep bounded provenance and guarded transition history so
-- future projectors can be idempotent and reversible.

CREATE TABLE behavior_evidence (
  evidence_id        TEXT PRIMARY KEY CHECK (typeof(evidence_id) = 'text' AND lifecycle_runtime_id_valid(evidence_id)),
  persona            TEXT NOT NULL CHECK (typeof(persona) = 'text' AND lifecycle_persona_valid(persona)),
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('message', 'schedule', 'run', 'tool', 'manual')),
  source_id          TEXT NOT NULL CHECK (typeof(source_id) = 'text' AND lifecycle_runtime_id_valid(source_id)),
  source_occurred_at TEXT NOT NULL CHECK (typeof(source_occurred_at) = 'text' AND source_occurred_at GLOB '????-??-??T??:??:??.???Z' AND strftime('%Y-%m-%dT%H:%M:%fZ', source_occurred_at) IS source_occurred_at),
  fingerprint        TEXT NOT NULL CHECK (typeof(fingerprint) = 'text' AND lifecycle_runtime_id_valid(fingerprint)),
  sentiment          TEXT NOT NULL CHECK (sentiment IN ('positive', 'negative', 'neutral')),
  confidence         REAL NOT NULL CHECK (typeof(confidence) = 'real' AND confidence >= 0 AND confidence <= 1),
  summary            TEXT NOT NULL CHECK (typeof(summary) = 'text' AND length(summary) BETWEEN 1 AND 4096 AND instr(summary, char(0)) = 0),
  metadata           TEXT NOT NULL DEFAULT '{}' CHECK (typeof(metadata) = 'text' AND json_valid(metadata) AND length(metadata) <= 32768),
  created_at         INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN -9007199254740991 AND 9007199254740991),
  UNIQUE (persona, evidence_id),
  UNIQUE (persona, fingerprint),
  UNIQUE (persona, source_kind, source_id, fingerprint)
);

CREATE INDEX idx_behavior_evidence_persona_created ON behavior_evidence(persona, created_at);
CREATE INDEX idx_behavior_evidence_persona_source ON behavior_evidence(persona, source_kind, source_id);

CREATE TRIGGER behavior_evidence_reject_replacements
BEFORE INSERT ON behavior_evidence
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM behavior_evidence
  WHERE evidence_id IS NEW.evidence_id
     OR (persona IS NEW.persona AND fingerprint IS NEW.fingerprint)
)
BEGIN
  SELECT RAISE(ABORT, 'behavior evidence cannot be replaced');
END;

CREATE TRIGGER behavior_evidence_reject_updates
BEFORE UPDATE ON behavior_evidence
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'behavior evidence is immutable');
END;

CREATE TABLE behavior_candidates (
  candidate_id       TEXT PRIMARY KEY CHECK (typeof(candidate_id) = 'text' AND lifecycle_runtime_id_valid(candidate_id)),
  persona            TEXT NOT NULL CHECK (typeof(persona) = 'text' AND lifecycle_persona_valid(persona)),
  kind               TEXT NOT NULL CHECK (kind IN ('style', 'preference', 'safety', 'tooling', 'context')),
  status             TEXT NOT NULL CHECK (status IN ('collecting', 'ready', 'proposed', 'rejected', 'expired')),
  summary            TEXT NOT NULL CHECK (typeof(summary) = 'text' AND length(summary) BETWEEN 1 AND 4096 AND instr(summary, char(0)) = 0),
  proposed_behavior  TEXT NOT NULL CHECK (typeof(proposed_behavior) = 'text' AND length(proposed_behavior) BETWEEN 1 AND 4096 AND instr(proposed_behavior, char(0)) = 0),
  confidence         REAL NOT NULL CHECK (typeof(confidence) = 'real' AND confidence >= 0 AND confidence <= 1),
  created_at         INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN -9007199254740991 AND 9007199254740991),
  updated_at         INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN -9007199254740991 AND 9007199254740991),
  expired_at         INTEGER CHECK (expired_at IS NULL OR (typeof(expired_at) = 'integer' AND expired_at BETWEEN -9007199254740991 AND 9007199254740991))
  , UNIQUE (persona, candidate_id)
);

CREATE INDEX idx_behavior_candidates_persona_status ON behavior_candidates(persona, status, updated_at);

CREATE TABLE behavior_candidate_evidence (
  candidate_id TEXT NOT NULL REFERENCES behavior_candidates(candidate_id) ON DELETE CASCADE,
  persona      TEXT NOT NULL CHECK (typeof(persona) = 'text' AND lifecycle_persona_valid(persona)),
  evidence_id  TEXT NOT NULL REFERENCES behavior_evidence(evidence_id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY (candidate_id, evidence_id),
  FOREIGN KEY (persona, candidate_id) REFERENCES behavior_candidates(persona, candidate_id) ON DELETE CASCADE,
  FOREIGN KEY (persona, evidence_id) REFERENCES behavior_evidence(persona, evidence_id) ON DELETE CASCADE
);

CREATE INDEX idx_behavior_candidate_evidence_persona ON behavior_candidate_evidence(persona, evidence_id);

CREATE TRIGGER behavior_candidate_evidence_reject_updates
BEFORE UPDATE ON behavior_candidate_evidence
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'behavior candidate evidence links are immutable');
END;

CREATE TRIGGER behavior_candidate_evidence_reject_deletes
BEFORE DELETE ON behavior_candidate_evidence
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'behavior candidate evidence links are append-only');
END;

CREATE TRIGGER behavior_candidates_reject_replacements
BEFORE INSERT ON behavior_candidates
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM behavior_candidates WHERE candidate_id IS NEW.candidate_id)
BEGIN
  SELECT RAISE(ABORT, 'behavior candidates cannot be replaced');
END;

CREATE TRIGGER behavior_candidates_guard_initial_insert
BEFORE INSERT ON behavior_candidates
FOR EACH ROW
WHEN NEW.status IS NOT 'collecting'
   OR NEW.expired_at IS NOT NULL
   OR NEW.created_at IS NOT NEW.updated_at
BEGIN
  SELECT RAISE(ABORT, 'behavior candidates must be inserted collecting');
END;

CREATE TRIGGER behavior_candidates_guard_transitions
BEFORE UPDATE ON behavior_candidates
FOR EACH ROW
WHEN NOT (
  NEW.candidate_id IS OLD.candidate_id
  AND NEW.persona IS OLD.persona
  AND NEW.kind IS OLD.kind
  AND NEW.summary IS OLD.summary
  AND NEW.proposed_behavior IS OLD.proposed_behavior
  AND NEW.confidence IS OLD.confidence
  AND NEW.created_at IS OLD.created_at
  AND NEW.updated_at > OLD.updated_at
  AND (
    (OLD.status = 'collecting' AND NEW.status IN ('ready', 'rejected') AND NEW.expired_at IS OLD.expired_at)
    OR (OLD.status = 'ready' AND NEW.status IN ('proposed', 'rejected') AND NEW.expired_at IS OLD.expired_at)
    OR (OLD.status = 'proposed' AND NEW.status = 'rejected' AND NEW.expired_at IS OLD.expired_at)
    OR (OLD.status IN ('collecting', 'ready', 'proposed', 'rejected') AND NEW.status = 'expired' AND NEW.expired_at IS NOT NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid behavior candidate update');
END;

CREATE TRIGGER behavior_candidates_guard_ready_evidence
BEFORE UPDATE OF status ON behavior_candidates
FOR EACH ROW
WHEN NEW.status = 'ready'
  AND (
    SELECT COUNT(*)
    FROM (
      SELECT e.source_kind, e.source_id
      FROM behavior_candidate_evidence ce
      JOIN behavior_evidence e
        ON e.evidence_id = ce.evidence_id
       AND e.persona = ce.persona
      WHERE ce.persona = NEW.persona
        AND ce.candidate_id = NEW.candidate_id
      GROUP BY e.source_kind, e.source_id
    )
  ) < 2
BEGIN
  SELECT RAISE(ABORT, 'ready behavior candidates require distinct linked evidence');
END;

CREATE TABLE behavior_promotions (
  promotion_id TEXT PRIMARY KEY CHECK (typeof(promotion_id) = 'text' AND lifecycle_runtime_id_valid(promotion_id)),
  persona      TEXT NOT NULL CHECK (typeof(persona) = 'text' AND lifecycle_persona_valid(persona)),
  candidate_id TEXT NOT NULL REFERENCES behavior_candidates(candidate_id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('proposed', 'evaluating', 'approved', 'activating', 'active', 'rolled_back', 'reopened', 'rejected', 'expired')),
  policy       TEXT NOT NULL CHECK (typeof(policy) = 'text' AND json_valid(policy) AND length(policy) <= 32768),
  evaluation   TEXT NOT NULL CHECK (typeof(evaluation) = 'text' AND json_valid(evaluation) AND length(evaluation) <= 32768),
  created_at   INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN -9007199254740991 AND 9007199254740991),
  updated_at   INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN -9007199254740991 AND 9007199254740991),
  UNIQUE (persona, promotion_id),
  UNIQUE (persona, candidate_id),
  FOREIGN KEY (persona, candidate_id) REFERENCES behavior_candidates(persona, candidate_id) ON DELETE CASCADE
);

CREATE INDEX idx_behavior_promotions_persona_status ON behavior_promotions(persona, status, updated_at);

CREATE TRIGGER behavior_promotions_reject_replacements
BEFORE INSERT ON behavior_promotions
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM behavior_promotions WHERE promotion_id IS NEW.promotion_id)
BEGIN
  SELECT RAISE(ABORT, 'behavior promotions cannot be replaced');
END;

CREATE TRIGGER behavior_promotions_guard_initial_insert
BEFORE INSERT ON behavior_promotions
FOR EACH ROW
WHEN NEW.status IS NOT 'proposed'
  OR NEW.created_at IS NOT NEW.updated_at
  OR NOT EXISTS (
    SELECT 1
    FROM behavior_candidates c
    WHERE c.persona = NEW.persona
      AND c.candidate_id = NEW.candidate_id
      AND c.status = 'ready'
  )
  OR (
    SELECT COUNT(*)
    FROM (
      SELECT e.source_kind, e.source_id
      FROM behavior_candidate_evidence ce
      JOIN behavior_evidence e
        ON e.evidence_id = ce.evidence_id
       AND e.persona = ce.persona
      WHERE ce.persona = NEW.persona
        AND ce.candidate_id = NEW.candidate_id
      GROUP BY e.source_kind, e.source_id
    )
  ) < 2
BEGIN
  SELECT RAISE(ABORT, 'behavior promotions require a ready candidate with distinct evidence');
END;

CREATE TRIGGER behavior_promotions_guard_transitions
BEFORE UPDATE ON behavior_promotions
FOR EACH ROW
WHEN NOT (
  NEW.promotion_id IS OLD.promotion_id
  AND NEW.persona IS OLD.persona
  AND NEW.candidate_id IS OLD.candidate_id
  AND NEW.policy IS OLD.policy
  AND NEW.evaluation IS OLD.evaluation
  AND NEW.created_at IS OLD.created_at
  AND NEW.updated_at > OLD.updated_at
  AND (
    (OLD.status = 'proposed' AND NEW.status IN ('evaluating', 'rejected', 'expired'))
    OR (OLD.status = 'evaluating' AND NEW.status IN ('approved', 'rejected', 'expired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('activating', 'rejected', 'expired'))
    OR (
      OLD.status = 'activating'
      AND NEW.status = 'active'
      AND EXISTS (
        SELECT 1
        FROM behavior_promotion_activations a
        WHERE a.persona = NEW.persona
          AND a.promotion_id = NEW.promotion_id
          AND a.activated_at IS NEW.updated_at
      )
    )
    OR (OLD.status = 'activating' AND NEW.status IN ('rejected', 'expired'))
    OR (
      OLD.status = 'active'
      AND NEW.status = 'rolled_back'
      AND EXISTS (
        SELECT 1
        FROM behavior_promotion_rollbacks r
        WHERE r.persona = NEW.persona
          AND r.promotion_id = NEW.promotion_id
          AND r.rolled_back_at IS NEW.updated_at
      )
    )
    OR (OLD.status = 'rolled_back' AND NEW.status = 'reopened')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid behavior promotion update');
END;

CREATE TRIGGER behavior_promotions_guard_candidate_evidence_transitions
BEFORE UPDATE OF status ON behavior_promotions
FOR EACH ROW
WHEN NEW.status IN ('evaluating', 'approved', 'activating', 'active')
  AND (
    NOT EXISTS (
      SELECT 1
      FROM behavior_candidates c
      WHERE c.persona = NEW.persona
        AND c.candidate_id = NEW.candidate_id
        AND c.status IN ('ready', 'proposed')
    )
    OR (
      SELECT COUNT(*)
      FROM (
        SELECT e.source_kind, e.source_id
        FROM behavior_candidate_evidence ce
        JOIN behavior_evidence e
          ON e.evidence_id = ce.evidence_id
         AND e.persona = ce.persona
        WHERE ce.persona = NEW.persona
          AND ce.candidate_id = NEW.candidate_id
        GROUP BY e.source_kind, e.source_id
      )
    ) < 2
  )
BEGIN
  SELECT RAISE(ABORT, 'behavior promotion transitions require candidate evidence');
END;

CREATE TABLE behavior_promotion_activations (
  activation_id      TEXT PRIMARY KEY CHECK (typeof(activation_id) = 'text' AND lifecycle_runtime_id_valid(activation_id)),
  persona            TEXT NOT NULL CHECK (typeof(persona) = 'text' AND lifecycle_persona_valid(persona)),
  promotion_id       TEXT NOT NULL REFERENCES behavior_promotions(promotion_id) ON DELETE CASCADE,
  prompt_artifact_id TEXT NOT NULL CHECK (typeof(prompt_artifact_id) = 'text' AND lifecycle_runtime_id_valid(prompt_artifact_id)),
  reload_id          TEXT NOT NULL CHECK (typeof(reload_id) = 'text' AND lifecycle_runtime_id_valid(reload_id)),
  activated_at       INTEGER NOT NULL CHECK (typeof(activated_at) = 'integer' AND activated_at BETWEEN -9007199254740991 AND 9007199254740991),
  UNIQUE (persona, activation_id),
  UNIQUE (persona, activation_id, promotion_id),
  UNIQUE (persona, promotion_id, prompt_artifact_id),
  FOREIGN KEY (persona, promotion_id) REFERENCES behavior_promotions(persona, promotion_id) ON DELETE CASCADE
);

CREATE TRIGGER behavior_promotion_activations_guard_lineage
BEFORE INSERT ON behavior_promotion_activations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM behavior_promotions p
  JOIN behavior_candidates c
    ON c.persona = p.persona
   AND c.candidate_id = p.candidate_id
  WHERE p.persona = NEW.persona
    AND p.promotion_id = NEW.promotion_id
    AND p.status = 'activating'
    AND c.status IN ('ready', 'proposed')
    AND (
      SELECT COUNT(*)
      FROM (
        SELECT e.source_kind, e.source_id
        FROM behavior_candidate_evidence ce
        JOIN behavior_evidence e
          ON e.evidence_id = ce.evidence_id
         AND e.persona = ce.persona
        WHERE ce.persona = c.persona
          AND ce.candidate_id = c.candidate_id
        GROUP BY e.source_kind, e.source_id
      )
    ) >= 2
)
BEGIN
  SELECT RAISE(ABORT, 'behavior promotion activations require activating evidenced promotion lineage');
END;

CREATE TRIGGER behavior_promotion_activations_reject_updates
BEFORE UPDATE ON behavior_promotion_activations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'behavior promotion activations are immutable');
END;

CREATE TRIGGER behavior_promotion_activations_reject_deletes
BEFORE DELETE ON behavior_promotion_activations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'behavior promotion activations are append-only');
END;

CREATE TABLE behavior_promotion_rollbacks (
  rollback_id   TEXT PRIMARY KEY CHECK (typeof(rollback_id) = 'text' AND lifecycle_runtime_id_valid(rollback_id)),
  persona       TEXT NOT NULL CHECK (typeof(persona) = 'text' AND lifecycle_persona_valid(persona)),
  activation_id TEXT NOT NULL REFERENCES behavior_promotion_activations(activation_id) ON DELETE CASCADE,
  promotion_id  TEXT NOT NULL REFERENCES behavior_promotions(promotion_id) ON DELETE CASCADE,
  reason        TEXT NOT NULL CHECK (typeof(reason) = 'text' AND lifecycle_identifier_valid(reason)),
  rolled_back_at INTEGER NOT NULL CHECK (typeof(rolled_back_at) = 'integer' AND rolled_back_at BETWEEN -9007199254740991 AND 9007199254740991),
  UNIQUE (activation_id),
  FOREIGN KEY (persona, promotion_id) REFERENCES behavior_promotions(persona, promotion_id) ON DELETE CASCADE,
  FOREIGN KEY (persona, activation_id) REFERENCES behavior_promotion_activations(persona, activation_id) ON DELETE CASCADE,
  FOREIGN KEY (persona, activation_id, promotion_id) REFERENCES behavior_promotion_activations(persona, activation_id, promotion_id) ON DELETE CASCADE
);

CREATE TRIGGER behavior_promotion_rollbacks_guard_active_lineage
BEFORE INSERT ON behavior_promotion_rollbacks
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM behavior_promotion_activations a
  JOIN behavior_promotions p
    ON p.persona = a.persona
   AND p.promotion_id = a.promotion_id
  WHERE a.persona = NEW.persona
    AND a.activation_id = NEW.activation_id
    AND a.promotion_id = NEW.promotion_id
    AND p.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'behavior promotion rollbacks require active activation lineage');
END;

CREATE TRIGGER behavior_promotion_rollbacks_reject_updates
BEFORE UPDATE ON behavior_promotion_rollbacks
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'behavior promotion rollbacks are immutable');
END;

CREATE TRIGGER behavior_promotion_rollbacks_reject_deletes
BEFORE DELETE ON behavior_promotion_rollbacks
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'behavior promotion rollbacks are append-only');
END;
