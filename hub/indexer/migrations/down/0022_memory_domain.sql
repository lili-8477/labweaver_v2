-- Manual revert of 0022_memory_domain.sql.
BEGIN;
ALTER TABLE memories DROP COLUMN IF EXISTS domain;
DELETE FROM schema_migrations WHERE version = 22;
COMMIT;
