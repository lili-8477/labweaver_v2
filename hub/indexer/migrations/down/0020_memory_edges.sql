-- Manual revert of 0020_memory_edges.sql.
BEGIN;
DROP TABLE IF EXISTS memory_edges;
DELETE FROM schema_migrations WHERE version = 20;
COMMIT;
