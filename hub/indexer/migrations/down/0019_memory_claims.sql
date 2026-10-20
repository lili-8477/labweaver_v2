-- Manual revert of 0019_memory_claims.sql. Deletes claim/experience rows.
BEGIN;
DELETE FROM memories WHERE type IN ('claim', 'experience');
DELETE FROM memory_audit_log WHERE action = 'status';
ALTER TABLE memory_audit_log DROP CONSTRAINT memory_audit_log_action_check;
ALTER TABLE memory_audit_log ADD CONSTRAINT memory_audit_log_action_check
  CHECK (action IN ('write', 'update', 'forget', 'restore', 'merge'));
DROP INDEX IF EXISTS memories_condition_idx;
ALTER TABLE memories
  DROP COLUMN status, DROP COLUMN claim_kind, DROP COLUMN confidence,
  DROP COLUMN validation_level, DROP COLUMN observed_at, DROP COLUMN valid_from,
  DROP COLUMN valid_to, DROP COLUMN access_class, DROP COLUMN condition_key,
  DROP COLUMN attrs;
ALTER TABLE memories DROP CONSTRAINT memories_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_type_check CHECK (type IN (
  'user','feedback','project','reference','session_summary','observation'));
DELETE FROM schema_migrations WHERE version = 19;
COMMIT;
