-- Manual revert of 0015_memory_audit_merge.sql (fails if 'merge' rows exist).
BEGIN;
ALTER TABLE memory_audit_log DROP CONSTRAINT memory_audit_log_action_check;
ALTER TABLE memory_audit_log ADD CONSTRAINT memory_audit_log_action_check
  CHECK (action IN ('write', 'update', 'forget', 'restore'));
DELETE FROM schema_migrations WHERE version = 15;
COMMIT;
