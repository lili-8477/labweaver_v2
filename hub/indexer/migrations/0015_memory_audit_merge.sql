-- Phase 2 merge-on-write: an agent folding a near-duplicate into an existing
-- memory is audited as 'merge' so merges can be counted separately from edits.
ALTER TABLE memory_audit_log DROP CONSTRAINT memory_audit_log_action_check;
ALTER TABLE memory_audit_log ADD CONSTRAINT memory_audit_log_action_check
  CHECK (action IN ('write', 'update', 'forget', 'restore', 'merge'));
