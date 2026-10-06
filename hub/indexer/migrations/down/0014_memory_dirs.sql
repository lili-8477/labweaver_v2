-- Manual revert of 0014_memory_dirs.sql. The migration runner never applies
-- files in this directory; run by hand, then delete schema_migrations row 14.
BEGIN;
DROP INDEX IF EXISTS memories_dir_idx;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_dir_fk;
ALTER TABLE memories DROP COLUMN IF EXISTS dir_key;
ALTER TABLE memories DROP COLUMN IF EXISTS scope;
DROP TABLE IF EXISTS memory_dirs;
DELETE FROM schema_migrations WHERE version = 14;
COMMIT;
