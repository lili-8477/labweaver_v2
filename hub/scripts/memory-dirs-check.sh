#!/usr/bin/env bash
# Phase 1 gate for memory directories (migration 0014): every live memory is
# filed, per-directory counts look sane, and 30 random rows for a manual
# spot-check of (scope, type, name) -> dir_key.
#
# Usage: hub/scripts/memory-dirs-check.sh [postgres-container]
set -euo pipefail
PG="${1:-labweaver-postgres}"
psql() { docker exec -i "$PG" psql -U labweaver -d labweaver -v ON_ERROR_STOP=1 "$@"; }

echo "== unfiled memories (must be 0)"
psql -Atc "SELECT count(*) FROM memories WHERE dir_key IS NULL"

echo "== live memories per directory"
psql -c "SELECT d.dir_key, count(m.memory_id) AS entries
           FROM memory_dirs d
           LEFT JOIN memories m ON m.dir_key = d.dir_key AND m.deleted_at IS NULL
          GROUP BY d.dir_key, d.sort ORDER BY d.sort"

echo "== 30 random rows to spot-check"
psql -c "SELECT scope, type, left(name, 60) AS name, dir_key
           FROM memories WHERE deleted_at IS NULL
          ORDER BY random() LIMIT 30"
