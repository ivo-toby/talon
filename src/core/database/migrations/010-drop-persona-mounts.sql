-- Migration 010: drop the dormant `mounts` column from personas.
--
-- The persona-level `mounts` field was originally intended to carry
-- Docker bind-mount definitions for a planned agent sandbox. That
-- sandbox concept is being retired in favour of a skill-level
-- sandbox feature, and no runtime consumer ever read the column for
-- any semantic purpose — the only plumbing was shuttle code between
-- the config loader, the persona repository, and tests.
--
-- SQLite 3.35+ supports `ALTER TABLE ... DROP COLUMN` directly, and
-- better-sqlite3 12.x ships with a recent enough SQLite.

ALTER TABLE personas DROP COLUMN mounts;
