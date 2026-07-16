-- Migration 017: lifecycle publication scope is manager-owned queue metadata,
-- never part of a caller-supplied work payload.

ALTER TABLE queue_items ADD COLUMN lifecycle_persona TEXT
  CHECK (lifecycle_persona IS NULL OR (typeof(lifecycle_persona) = 'text' AND lifecycle_persona_valid(lifecycle_persona)));
ALTER TABLE queue_items ADD COLUMN lifecycle_item_type TEXT
  CHECK (
    (lifecycle_persona IS NULL AND lifecycle_item_type IS NULL)
    OR (typeof(lifecycle_persona) = 'text' AND lifecycle_item_type IN ('message', 'schedule'))
  );

CREATE INDEX idx_queue_items_lifecycle_scope ON queue_items(lifecycle_persona, lifecycle_item_type)
  WHERE lifecycle_persona IS NOT NULL;
