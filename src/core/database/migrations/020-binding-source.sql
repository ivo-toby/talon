-- Records who owns a binding.
--
-- 'config' marks a thread-scoped binding that was created from the YAML
-- `bindings` list (an entry with `thread`). Startup reconciliation may update
-- and remove those, so deleting the YAML entry unbinds the conversation.
-- 'runtime' is everything else, including rows that predate this column;
-- reconciliation never removes a runtime binding.

ALTER TABLE bindings ADD COLUMN source TEXT NOT NULL DEFAULT 'runtime'
  CHECK (source IN ('runtime', 'config'));
