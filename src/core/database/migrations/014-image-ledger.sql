-- Image ledger: recovery source references, durable Images, pending Ingestion,
-- and terminal admission records for intentionally unrouted image messages.
--
-- Numbering note: 007 is historically duplicated by two files
-- (007-a2a-tasks.sql, 007-execution-environments.sql). That duplication is frozen
-- history and is NOT a naming precedent: the runner tracks a single PRAGMA
-- user_version, so a second file reusing an applied prefix is skipped, never
-- re-run. This migration therefore takes the next free number (014), greater than
-- every existing numeric prefix, and no later migration may reuse a prefix. The
-- Finding ledger receives its own later free number (TASK-011).
--
-- Vocabulary follows src/images/image-types.ts and CONTEXT.md:
--   * Admission is the durable acceptance of an inbound message and the creation of
--     its Images; the receipt (`received_at`) is that moment on the local clock,
--     independent of platform and EXIF timestamps.
--   * An Image carries one of the four states with exactly the matching reason, and
--     survives the Normalized file it was produced from.
--   * Ingestion is per owning Message, is `pending` until the message is enqueued,
--     and stays `completed` even after queue-item removal.
--
-- Durability rules encoded here:
--   * an Image is unique by its globally unique id AND by (message_id, ordinal), so
--     redelivery reuses a slot instead of appending a duplicate;
--   * every Image and Ingestion is thread-owned (denormalised `thread_id`, validated
--     against the owning Message by the repositories) and is queried without joining
--     `messages`, so history cutoffs and retention cannot hide recovery work;
--   * `image_ingestions.queue_item_id` deliberately has NO foreign key: queue
--     retention deletes queue items, and a cascade would destroy the completion
--     record that proves the message must not be enqueued again.

-- Internal recovery source reference for one image-bearing inbound message.
-- `channel` and the external identifiers are trusted provenance written by the
-- pipeline, never extracted from message text. They let restart and redelivery
-- re-link an existing Image instead of creating a new one. Recovery-only: these
-- references are never projected onto a public Image descriptor.
CREATE TABLE IF NOT EXISTS image_source_messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel <> ''),
  external_message_id TEXT NOT NULL CHECK (external_message_id <> ''),
  external_chat_id TEXT NOT NULL CHECK (external_chat_id <> ''),
  created_at INTEGER NOT NULL
);

-- One reference per external message per channel: repeated delivery of the same
-- external message resolves to the same source reference.
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_source_messages_external
  ON image_source_messages(channel, external_message_id, external_chat_id);

-- Image: one unit of durable image state, owned by exactly one thread and one
-- position within its owning message.
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  -- Owning inbound Message. Every Image comes from an Attachment on a Message.
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- Zero-based source order within the owning message. Stable across redelivery.
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  -- Ownership scope, denormalised from the Message at Admission and validated by
  -- ImageRepository: a caller-supplied thread that disagrees with the owning
  -- Message is rejected instead of trusted.
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL REFERENCES image_source_messages(id) ON DELETE CASCADE,
  -- `processing` is internal to Ingestion; `rejected` and `unavailable` are terminal
  -- and final — a late fetch or conversion result can never overwrite them.
  state TEXT NOT NULL DEFAULT 'processing'
    CHECK (state IN ('processing', 'available', 'rejected', 'unavailable')),
  rejection_reason TEXT CHECK (
    rejection_reason IS NULL
    OR rejection_reason IN (
      'unsupported_mime', 'count_limit', 'size_limit', 'animated',
      'download_failed', 'conversion_failed', 'processing_interrupted', 'processing_failed'
    )
  ),
  unavailability_reason TEXT CHECK (
    unavailability_reason IS NULL
    OR unavailability_reason IN ('expired', 'file_missing')
  ),
  -- Declared channel filename: metadata only, never a path to open.
  filename TEXT CHECK (filename IS NULL OR filename <> ''),
  -- Declared MIME type. A filename never establishes MIME.
  mime_type TEXT CHECK (mime_type IS NULL OR mime_type <> ''),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  -- Validated ImageExifMetadata JSON (approved EXIF subset, no invented values).
  -- NULL means unknown. Never raw parser output and never pixels.
  exif TEXT CHECK (exif IS NULL OR exif <> ''),
  -- Admission receipt on the local clock. Never moved by access, retry, or restart.
  received_at INTEGER NOT NULL,
  -- When the Normalized file stops being retained. Never extended by access or retry.
  expires_at INTEGER NOT NULL,
  -- Fixed post-admission normalization deadline for the owning message, persisted
  -- per Image so neither redelivery nor restart can reset it.
  processing_deadline_at INTEGER NOT NULL,
  -- Normalization attempts actually started for this Image (bounded by policy),
  -- independent of the queue item's own attempt counter.
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  updated_at INTEGER NOT NULL,
  -- Exactly one reason in a terminal state and none otherwise, enforced in
  -- storage. SQLite only accepts table constraints after every column definition,
  -- so this pairing rule must stay below the columns it references.
  CHECK (
    (state = 'rejected' AND rejection_reason IS NOT NULL AND unavailability_reason IS NULL)
    OR (state = 'unavailable' AND unavailability_reason IS NOT NULL AND rejection_reason IS NULL)
    OR (state IN ('processing', 'available') AND rejection_reason IS NULL AND unavailability_reason IS NULL)
  ),
  UNIQUE (message_id, ordinal)
);

-- Newest-first thread inventory and terminal-Image queries, ordered the way
-- descriptors and lookup sort: receipt descending, id ascending.
CREATE INDEX IF NOT EXISTS idx_images_thread_received
  ON images(thread_id, received_at DESC, id ASC);

-- State-scoped recovery within one thread.
CREATE INDEX IF NOT EXISTS idx_images_thread_state
  ON images(thread_id, state, received_at ASC, id ASC);

-- Retention/expiry sweep over Images whose content can still become unavailable.
CREATE INDEX IF NOT EXISTS idx_images_expirable
  ON images(expires_at)
  WHERE state IN ('processing', 'available');

CREATE INDEX IF NOT EXISTS idx_images_source_ref
  ON images(source_ref);

-- Ingestion: one row per image-bearing Message that produced Images, recording that
-- the message still needs queue admission (`pending`) or has already been admitted
-- (`completed`). `UNIQUE (message_id)` is the "one owner per message" guarantee.
--
-- Completion is durable: purging the referenced queue item leaves this row
-- `completed`, and nothing here is inferred from queue existence.
CREATE TABLE IF NOT EXISTS image_ingestions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  -- Denormalised for cutoff-independent recovery queries; validated against the
  -- owning Message by ImageIngestionRepository.
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  -- Traceability only, intentionally not a foreign key: queue retention deletes
  -- queue items and must not reopen or destroy a completed Ingestion.
  queue_item_id TEXT,
  admitted_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status = 'pending' AND completed_at IS NULL)
  )
);

-- Recovery sweep for Ingestion that still needs admission, oldest first, scoped by
-- thread without joining `messages`.
CREATE INDEX IF NOT EXISTS idx_image_ingestions_pending
  ON image_ingestions(admitted_at, message_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_image_ingestions_thread_pending
  ON image_ingestions(thread_id, admitted_at, message_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_image_ingestions_queue_item
  ON image_ingestions(queue_item_id)
  WHERE queue_item_id IS NOT NULL;

-- Terminal admission record: written instead of Images/Ingestion when an
-- image-bearing Message is intentionally not routed (no binding, unsupported
-- channel, policy rejection, or images disallowed in this context). The record is
-- terminal on write — it has no lifecycle — and the Message itself stays readable
-- in ordinary history. Text-only Messages and routed Messages never get one.
CREATE TABLE IF NOT EXISTS image_admission_records (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel <> ''),
  reason TEXT NOT NULL CHECK (
    reason IN ('no_binding', 'channel_unsupported', 'policy_denied', 'images_disallowed')
  ),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_admission_records_thread_created
  ON image_admission_records(thread_id, created_at DESC, message_id ASC);
