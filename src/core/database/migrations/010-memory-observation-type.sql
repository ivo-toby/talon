-- Migration 010: Add 'observation' to memory_items type CHECK constraint
--
-- The observational memory feature stores context observations as
-- memory_items with type='observation'. The existing CHECK constraint
-- only allows fact|summary|note|embedding_ref, so this migration
-- recreates the table with the updated constraint.

-- 1. Create the new table with updated CHECK constraint.
CREATE TABLE memory_items_new (
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('fact', 'summary', 'note', 'embedding_ref', 'observation')),
  content       TEXT NOT NULL,
  embedding_ref TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (thread_id, id)
);

-- 2. Copy existing data.
INSERT INTO memory_items_new (thread_id, id, type, content, embedding_ref, metadata, created_at, updated_at)
  SELECT thread_id, id, type, content, embedding_ref, metadata, created_at, updated_at
  FROM memory_items;

-- 3. Drop old table and rename.
DROP TABLE memory_items;
ALTER TABLE memory_items_new RENAME TO memory_items;

-- 4. Recreate index.
CREATE INDEX idx_memory_thread ON memory_items(thread_id, type);
