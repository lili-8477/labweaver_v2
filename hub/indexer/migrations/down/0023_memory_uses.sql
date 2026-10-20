-- Manual revert of 0023_memory_uses.sql.
BEGIN;
DROP TABLE IF EXISTS memory_uses;
DELETE FROM schema_migrations WHERE version = 23;
COMMIT;
