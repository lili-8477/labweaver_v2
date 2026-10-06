#!/usr/bin/env bash
# Phase 2 gate: duplicate rate = share of live memories that have a near
# duplicate (cosine >= threshold) from the same owner in the same directory.
# Run once before deploying merge-on-write and again after a few weeks; the
# gate is an 80% drop. Also prints merges recorded in the audit log.
#
# Usage: hub/scripts/memory-dup-rate.sh [threshold=0.9] [postgres-container]
set -euo pipefail
T="${1:-0.9}"
PG="${2:-labweaver-postgres}"
docker exec -i "$PG" psql -U labweaver -d labweaver -v ON_ERROR_STOP=1 -v t="$T" <<'SQL'
WITH live AS (
  SELECT m.memory_id, m.username, m.project_dir, m.dir_key, mc.embedding
    FROM memories m JOIN memory_chunks mc USING (memory_id)
   WHERE m.deleted_at IS NULL AND mc.embedding IS NOT NULL
),
dup AS (
  SELECT DISTINCT a.memory_id
    FROM live a JOIN live b
      ON a.memory_id <> b.memory_id
     AND a.username = b.username
     AND a.project_dir IS NOT DISTINCT FROM b.project_dir
     AND a.dir_key = b.dir_key
     AND 1 - (a.embedding <=> b.embedding) >= :t
)
SELECT (SELECT count(DISTINCT memory_id) FROM live)                      AS live_memories,
       (SELECT count(*) FROM dup)                                        AS with_near_duplicate,
       round(100.0 * (SELECT count(*) FROM dup)
             / NULLIF((SELECT count(DISTINCT memory_id) FROM live), 0), 1) AS dup_rate_pct,
       (SELECT count(*) FROM memory_audit_log WHERE action = 'merge')    AS merges;
SQL
