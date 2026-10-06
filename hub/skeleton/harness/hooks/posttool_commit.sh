#!/usr/bin/env bash
# PostToolUse hook (Write/Edit on progress.md) — auto-commit progress.md after every state change.
set -euo pipefail

# Harness toggle: stay no-op unless self-driving mode is enabled.
# Enabled when ~/.claude/.harness_active exists (toggled from the frontend).
[[ -f "$HOME/.claude/.harness_active" ]] || exit 0

parsed="$(python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("\t"); sys.exit(0)
agent = d.get("subagent_type") or d.get("agent") or "tick"
fp = (d.get("tool_input") or {}).get("file_path") or ""
print(f"{agent}\t{fp}")
' 2>/dev/null || echo $'\t')"

agent="$(printf '%s' "$parsed" | cut -f1)"
file_path="$(printf '%s' "$parsed" | cut -f2)"

case "$file_path" in
  */progress.md|progress.md) ;;
  *) exit 0 ;;
esac

# Commit in the project's own repo: the edited file's directory, not $PWD
# (dsh runs hooks in the session workspace, not the project).
cd "$(dirname "$file_path")" 2>/dev/null || exit 0

# Only commit if we're inside a git repo
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

if git diff --quiet -- progress.md 2>/dev/null; then
  exit 0
fi

git add progress.md
git commit -q -m "tick: ${agent:-tick} progress.md updated" || true
exit 0
