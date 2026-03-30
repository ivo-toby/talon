/**
 * Ordered migration manifest for the bundled Talon schema.
 *
 * This explicit list lets the application append new bundled migrations
 * without being constrained by historical filename version prefixes.
 */

export const REGISTERED_MIGRATIONS = [
  '001-initial-schema.sql',
  '002-memory-compound-pk.sql',
  '003-background-tasks.sql',
  '004-background-task-provider-name.sql',
  '005-run-provider-name.sql',
  '006-background-task-traceparent.sql',
  '007-a2a-tasks.sql',
  '007-execution-environments.sql',
  '008-background-task-sandbox-columns.sql',
  '009-execution-env-checkpoints.sql',
  '010-governance.sql',
] as const;
