-- Add durable operator approval provenance for governed prompt activations.

ALTER TABLE behavior_promotion_activations
  ADD COLUMN approved_by TEXT
    CHECK (
      approved_by IS NULL
      OR (
        typeof(approved_by) = 'text'
        AND lifecycle_runtime_id_valid(approved_by)
      )
    );
