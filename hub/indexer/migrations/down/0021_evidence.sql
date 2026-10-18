-- Manual revert of 0021_evidence.sql.
BEGIN;
DROP TABLE IF EXISTS memory_evidence;
DROP TABLE IF EXISTS evidence_assets;
DELETE FROM schema_migrations WHERE version = 21;
COMMIT;
