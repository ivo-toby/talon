/**
 * Ordered migration manifest for the bundled Talon schema.
 *
 * This explicit list lets the application append new bundled migrations
 * without being constrained by historical filename version prefixes.
 *
 * Each entry maps a migration file to its **user_version** integer.
 * For files that existed before the manifest was introduced, the version
 * matches the filename prefix. Later entries may diverge from the prefix
 * (e.g., 007-execution-environments.sql → version 8) because the manifest
 * is now the source of truth for ordering.
 */

export const REGISTERED_MIGRATIONS: ReadonlyArray<{ file: string; version: number }> = [
  { file: '001-initial-schema.sql',               version: 1 },
  { file: '002-memory-compound-pk.sql',            version: 2 },
  { file: '003-background-tasks.sql',              version: 3 },
  { file: '004-background-task-provider-name.sql',  version: 4 },
  { file: '005-run-provider-name.sql',             version: 5 },
  { file: '006-background-task-traceparent.sql',    version: 6 },
  { file: '007-a2a-tasks.sql',                     version: 7 },
  { file: '007-execution-environments.sql',        version: 8 },
  { file: '008-background-task-sandbox-columns.sql', version: 9 },
  { file: '009-execution-env-checkpoints.sql',     version: 10 },
  { file: '010-governance.sql',                    version: 11 },
];
