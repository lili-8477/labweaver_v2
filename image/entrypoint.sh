#!/bin/bash
# labweaver container entrypoint.
#
# Responsibilities (kept intentionally small — everything else belongs in the adapter):
#   1. Source per-user .env if present (DEEPSEEK_API_KEY, OLLAMA_API_KEY, etc.)
#   2. Ensure ~/.claude/{skills,agents} and DSH_HOME exist even when no bind-mount was attached
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
mkdir -p "${HOME}/.claude/skills" "${HOME}/.claude/agents" "${HOME}/.claude/projects" "${DSH_HOME}"

# DeepSeek Harness reads CLAUDE.md natively but not its `@/workspace/.labweaver/shared.md`
# import. Its user-global instruction file is $DSH_HOME/AGENTS.md, so point
# that at the shared file (mounted live, so org edits still propagate).
if [[ -f /workspace/.labweaver/shared.md ]]; then
    ln -sfn /workspace/.labweaver/shared.md "${DSH_HOME}/AGENTS.md"
fi

# Stitch shared + per-user skills into ~/.claude/skills, one of the skill
# roots the adapter registers with DeepSeek Harness (see adapter dsh/patch.ts);
# the raw bind-mounts (skills-shared, skills-user) are not scanned. Use symlinks so changes
# on either side propagate without copying.
#
# Precedence: user skills win on a name collision.
stitch_skills() {
    local dest="${HOME}/.claude/skills"
    # Clear stale symlinks (from prior container runs). Leaves real dirs alone.
    find "${dest}" -mindepth 1 -maxdepth 1 -type l -delete 2>/dev/null || true

    # User skills first so they take precedence.
    if [[ -d "${HOME}/.claude/skills-user" ]]; then
        for d in "${HOME}/.claude/skills-user"/*/; do
            [[ -d "$d" ]] || continue
            local name
            name=$(basename "$d")
            ln -sfn "$d" "${dest}/${name}"
        done
    fi

    # Shared skills fill in anything user didn't provide.
    if [[ -d "${HOME}/.claude/skills-shared" ]]; then
        for d in "${HOME}/.claude/skills-shared"/*/; do
            [[ -d "$d" ]] || continue
            local name
            name=$(basename "$d")
            [[ -e "${dest}/${name}" ]] && continue
            ln -s "$d" "${dest}/${name}"
        done
    fi
}
stitch_skills

exec node /opt/adapter/dist/index.js
