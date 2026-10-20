-- Manual revert of 0024_glasses.sql.
BEGIN;
DROP TABLE IF EXISTS glasses_parts;
DROP TABLE IF EXISTS glasses_files;
DROP TABLE IF EXISTS glasses_recordings;
DELETE FROM schema_migrations WHERE version = 24;
COMMIT;
