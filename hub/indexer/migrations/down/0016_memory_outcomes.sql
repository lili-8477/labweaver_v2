-- Manual revert of 0016_memory_outcomes.sql.
BEGIN;
ALTER TABLE memories DROP COLUMN success_count, DROP COLUMN failure_count;
DELETE FROM schema_migrations WHERE version = 16;
COMMIT;
