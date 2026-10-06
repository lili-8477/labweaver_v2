#!/usr/bin/env bash
# Prepare hub/workspaces/devuser for docker-compose.dev.yml: the host-side
# files the dev container bind-mounts, configured the way add-user.sh
# configures a real user. Idempotent; run before the first `compose up` and
# again after the harness hook list or MCP registration changes.
#
# Commands, agents and hook scripts are mounted read-only straight from
# hub/skeleton/harness, so they need no copying here.
set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="${HUB_DIR}/workspaces/devuser"

mkdir -p "${WORKSPACE}/.claude/skills" "${WORKSPACE}/.claude/chats" \
         "${WORKSPACE}/.claude/claude-projects" "${WORKSPACE}/.dsh" \
         "${WORKSPACE}/projects" "${WORKSPACE}/local_projects"

[[ -f "${WORKSPACE}/.claude/settings.json" ]] || echo '{}' > "${WORKSPACE}/.claude/settings.json"
python3 "${HUB_DIR}/scripts/merge-harness-hooks.py" "${WORKSPACE}/.claude/settings.json"

# The dev compose names the indexer service `indexer`, not labweaver-indexer.
python3 "${HUB_DIR}/scripts/merge-mcp-config.py" "${WORKSPACE}/.mcp.json" devuser "http://indexer:8400"

echo "devuser ready: ${WORKSPACE}"
