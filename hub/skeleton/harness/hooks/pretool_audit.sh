#!/usr/bin/env bash
# PreToolUse hook — append every tool call to .audit.log
set -euo pipefail

INPUT="$(cat)"

# Stay no-op unless this session is in auto mode: the adapter marks it with
# ~/.claude/auto/<session id>, which holds the project path (adapter/src/harness.ts).
SID="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("session_id",""), end="")
except Exception: pass' 2>/dev/null || true)"
SESSION_FILE="$HOME/.claude/auto/$SID"
[[ -n "$SID" && -f "$SESSION_FILE" ]] || exit 0

# Log into the session's project.
HARNESS="$(cat "$SESSION_FILE" 2>/dev/null || true)"
LOG="${HARNESS:-$PWD}/.audit.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

parsed="$(printf '%s' "$INPUT" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("?\t?\t<parse-error>"); sys.exit(0)
agent = d.get("subagent_type") or d.get("agent") or "main"
tool = d.get("tool_name") or "?"
ti = d.get("tool_input") or {}
# Build a compact summary from common keys
parts = []
for k in ("command","file_path","path","prompt","description","content"):
    v = ti.get(k)
    if not v: continue
    s = str(v).replace("\n", " ")
    parts.append(f"{k}={s}")
    if len(" | ".join(parts)) >= 160:
        break
summary = " | ".join(parts)[:160]
print(f"{agent}\t{tool}\t{summary}")
' 2>/dev/null || echo $'?\t?\t<parse-error>')"

agent="$(printf '%s' "$parsed" | cut -f1)"
tool="$(printf '%s' "$parsed" | cut -f2)"
summary="$(printf '%s' "$parsed" | cut -f3-)"

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s | %s | %s | %s\n' "$ts" "$agent" "$tool" "$summary" >> "$LOG"
exit 0
