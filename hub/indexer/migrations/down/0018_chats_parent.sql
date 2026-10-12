-- Manual revert of 0018_chats_parent.sql.
BEGIN;
DROP INDEX IF EXISTS chats_parent_chat_id_idx;
ALTER TABLE chats DROP COLUMN parent_chat_id;
DELETE FROM schema_migrations WHERE version = 18;
COMMIT;
