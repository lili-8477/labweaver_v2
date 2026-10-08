-- Manual revert of 0017_chats_mode.sql.
BEGIN;
ALTER TABLE chats DROP COLUMN mode;
DELETE FROM schema_migrations WHERE version = 17;
COMMIT;
