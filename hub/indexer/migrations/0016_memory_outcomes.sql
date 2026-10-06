-- Phase 3: memories are ranked by how tasks that used them went, not by how
-- often search returned them. hit_count/last_hit_at now mean "used in a
-- task" (bumped by POST /memory/feedback); search no longer touches them.
ALTER TABLE memories
  ADD COLUMN success_count INT NOT NULL DEFAULT 0,
  ADD COLUMN failure_count INT NOT NULL DEFAULT 0;
