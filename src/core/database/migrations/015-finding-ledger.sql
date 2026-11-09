-- Finding ledger: canonical Findings produced by successful Inspections and
-- their source Image associations (TASK-011).
--
-- Numbering note: 007 is historically duplicated by two files
-- (007-a2a-tasks.sql, 007-execution-environments.sql). That duplication is frozen
-- history and is NOT a naming precedent: the runner tracks a single PRAGMA
-- user_version, so a second file reusing an applied prefix is skipped, never
-- re-run. This migration takes the next free number (015), greater than every
-- existing numeric prefix including 014-image-ledger.sql, and no later
-- migration may reuse a prefix.
--
-- Vocabulary follows src/images/finding-types.ts and CONTEXT.md:
--   * A Finding is the recorded answer of a successful Inspection. It is written
--     only on success and is exact: the question, the answer, the extracted text,
--     the uncertainty statement, and the usage the producing model actually
--     reported. Nothing here is paraphrased, summarized, or defaulted.
--   * A Finding is owned by exactly one thread and one run (trusted provenance,
--     supplied by the Inspection layer — never extracted from model output).
--   * A Finding references the Images that were inspected; it remains available
--     after those Images' Normalized files expire, after the main run fails, and
--     after context rotation.
--
-- Durability rules encoded here:
--   * `findings.id` is globally unique (PRIMARY KEY): a Finding is addressed by
--     its id alone, independent of thread, message, or queue state;
--   * `thread_id` is denormalised from the owning run and validated by
--     FindingRepository against `runs.thread_id`, exactly like the Image ledger
--     validates against the owning Message — a caller-supplied thread that
--     disagrees with the provenance is rejected instead of trusted;
--   * `run_id` references `runs` WITHOUT an ON DELETE action: Finding rows are
--     not owned by the run lifecycle. Run status transitions (failed, cancelled,
--     ...) never touch this table, and deleting a run row that still has
--     Findings fails explicitly instead of silently erasing canonical text.
--     Thread- and channel-level cascade removal still completes, because SQLite
--     checks immediate NO ACTION constraints at the end of the deleting
--     statement, after the same statement's own cascades have removed the
--     referencing rows;
--   * `finding_images` carries the source association: each row references a
--     Finding and an Image of the same thread (ownership enforced at the write
--     boundary by FindingRepository). Image rows are removed by cascade only
--     when the owning thread disappears, which removes the Finding anyway — so
--     the association never outlives either side in practice. Expiry, rejection,
--     and file cleanup are state changes on `images` rows and never delete an
--     Image row, so Findings survive them;
--   * queries on this ledger read `findings` and `finding_images` only — never
--     `messages` and never `queue_items` — so a message history cutoff, a purged
--     queue item, or a failed main run cannot hide a canonical Finding;
--   * a Finding never creates a synthetic message and `tool_results` is NOT
--     canonical storage: nothing in this ledger writes either table.

-- One canonical Finding. Stores text and numbers only — no pixels, no paths,
-- no download credentials.
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  -- Trusted provenance: the run whose tool context carried the Inspection.
  -- The FK without a delete action is deliberate, see the durability rules above.
  run_id TEXT NOT NULL REFERENCES runs(id),
  -- Ownership scope, denormalised from the run and validated by FindingRepository.
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  -- The Inspection question, exactly as submitted. Nonempty, verbatim.
  question TEXT NOT NULL CHECK (question <> ''),
  -- The winning model's answer, verbatim. Nonempty by construction: an
  -- Inspection that produced no answer never reaches this table.
  answer TEXT NOT NULL CHECK (answer <> ''),
  -- Text the model reported as extracted from the Image(s). NULL means the model
  -- reported none; never invented.
  extracted_text TEXT CHECK (extracted_text IS NULL OR extracted_text <> ''),
  -- The model's own uncertainty statement, verbatim free text. NULL means the
  -- model reported none. There is deliberately no closed enum: the spec defines
  -- no fixed uncertainty vocabulary and no invented value is allowed.
  uncertainty TEXT CHECK (uncertainty IS NULL OR uncertainty <> ''),
  -- The vision model in the chain that actually produced this answer (the
  -- winning failover attempt). Distinct from the run's foreground model.
  model_name TEXT NOT NULL CHECK (model_name <> ''),
  -- Token usage exactly as the producing model reported it. Each field is NULL
  -- when the model did not report it; nothing here is estimated or fabricated.
  usage_input_tokens INTEGER CHECK (usage_input_tokens IS NULL OR usage_input_tokens >= 0),
  usage_output_tokens INTEGER CHECK (usage_output_tokens IS NULL OR usage_output_tokens >= 0),
  usage_cache_read_tokens INTEGER CHECK (usage_cache_read_tokens IS NULL OR usage_cache_read_tokens >= 0),
  usage_cache_write_tokens INTEGER CHECK (usage_cache_write_tokens IS NULL OR usage_cache_write_tokens >= 0),
  -- Creation time on the local clock, stamped by FindingRepository (trusted
  -- monotonic clock) at durable admission of the Finding.
  created_at INTEGER NOT NULL
);

-- Thread-scoped chronological page: creation descending, then id ascending —
-- the order every Finding projection and lookup sorts by, and the keyset used
-- for pagination.
CREATE INDEX IF NOT EXISTS idx_findings_thread_created
  ON findings(thread_id, created_at DESC, id ASC);

-- Provenance lookup: the Findings one run produced.
CREATE INDEX IF NOT EXISTS idx_findings_run
  ON findings(run_id);

-- Source association: which Image(s) one Finding was produced from.
CREATE TABLE IF NOT EXISTS finding_images (
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  -- Same-thread ownership is enforced by FindingRepository before the insert;
  -- the FK keeps the storage-level invariant that associations only ever point
  -- at Image rows.
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  -- The position of this Image in the Inspection's image list, so the recorded
  -- association order matches the question's context.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- One association per (Finding, Image): an Inspection inspects distinct
  -- Images, and redelivery must not append a duplicate.
  PRIMARY KEY (finding_id, image_id),
  UNIQUE (finding_id, position)
);

-- Image-filtered lookup: Findings that reference one Image.
CREATE INDEX IF NOT EXISTS idx_finding_images_image
  ON finding_images(image_id, finding_id);
