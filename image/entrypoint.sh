#!/bin/bash
# labweaver container entrypoint.
#
# Responsibilities (kept intentionally small — everything else belongs in the adapter):
#   1. Source per-user .env if present (DEEPSEEK_API_KEY, OLLAMA_API_KEY, etc.)
#   2. Point ~/.labweaver at the workspace's labweaver folder and ensure its subdirs + DSH_HOME exist
#   3. Expose the shared lab instructions to DeepSeek Harness
#   4. Exec the adapter. SIGTERM handling comes from tini + adapter's signal trap.

set -euo pipefail

ENV_FILE="${WORKSPACE_ROOT:-/workspace}/.env"
if [[ -f "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
fi

DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
# The labweaver folder (skills, commands, agents, hooks, settings.json, Auto
# markers, transcripts) is mounted whole at <workspace>/.labweaver. Code that
# resolves it from $HOME (the adapter, dsh plugins, hooks) reaches it through
# this link.
LABWEAVER_DIR="${WORKSPACE_ROOT:-/workspace}/.labweaver"
mkdir -p "${LABWEAVER_DIR}"/{skills,agents,commands,hooks,projects,auto} "${DSH_HOME}"
ln -sfn "${LABWEAVER_DIR}" "${HOME}/.labweaver"

# DeepSeek Harness reads CLAUDE.md natively but not its `@/workspace/.labweaver/shared.md`
# import. Its user-global instruction file is $DSH_HOME/AGENTS.md, so point
# that at the shared file (mounted live, so org edits still propagate).
if [[ -f /workspace/.labweaver/shared.md ]]; then
    ln -sfn /workspace/.labweaver/shared.md "${DSH_HOME}/AGENTS.md"
fi

exec node /opt/adapter/dist/index.js
