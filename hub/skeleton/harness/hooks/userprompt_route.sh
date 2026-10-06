#!/usr/bin/env bash
# UserPromptSubmit hook. Two independent responsibilities:
#
#   1. Drain ~/.claude/.chpc_pending if non-empty — emit any CHPC job
#      terminal-state notifications as additional context so the agent
#      sees them prepended to the user's prompt this turn. Always runs,
#      regardless of harness state or whether the prompt is a slash command:
#      the agent should never miss a job-status event.
#
#   2. Memory recall: for task-like prompts (not slash commands, not short
#      chat), search memory and inject the top hits' one-line summaries.
#
# Auto mode routing lives in the adapter (src/harness.ts) and the tick dsh
# plugin, not here.
set -uo pipefail
#
# Context is emitted as JSON additionalContext (see the end of this file):
# DeepSeek Harness's Claude-hooks plugin ignores plain stdout, and Claude
# Code accepts both forms. The body below stays unindented inside route()
# because its heredoc terminators must start at column 0.

LOG="$HOME/.claude/.harness_active.log"
log() { printf '%s userprompt_route %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

INBOX="${CHPC_INBOX:-$HOME/.claude/.chpc_pending}"

# Read the JSON envelope from stdin once; extract the prompt field.
INPUT="$(cat)"
PROMPT="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("prompt",""), end="")
except Exception:
    pass' 2>/dev/null || true)"

route() {
# ── 1. Drain CHPC notifications ──────────────────────────────────────
# Atomic rotate: move to a tmpfile so a watcher writing right now doesn't
# race the read. Anything written after the rename lands in a fresh INBOX
# and surfaces on the *next* prompt.
if [[ -s "$INBOX" ]]; then
  drained="${INBOX}.draining.$$"
  if mv "$INBOX" "$drained" 2>/dev/null; then
    log "drain: $(wc -l < "$drained" | tr -d ' ') notification(s)"
    printf '[CHPC job watcher — events since your last prompt]\n\n'
    python3 - "$drained" <<'PY' || cat "$drained"
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
for raw in p.read_text().splitlines():
    raw = raw.strip()
    if not raw:
        continue
    try:
        d = json.loads(raw)
    except Exception:
        print(f"- {raw}")
        continue
    jid = d.get("jobid", "?")
    step = d.get("step", "?")
    state = d.get("state", "?")
    elapsed = d.get("elapsed", "?")
    exitc = d.get("exit", "?")
    ts = d.get("ts", "")
    note = d.get("note", "") or ""
    extra = f" ({note})" if note else ""
    print(f"- job {jid} [{step}] -> {state}  elapsed={elapsed} exit={exitc}  at {ts}{extra}")
PY
    printf '\n'
    printf 'Before continuing with the user message, check each job: read its log/output, '
    printf 'note success or failure, and surface anything the user should know. '
    printf 'If a job FAILED/TIMEOUT/OOM, name that explicitly in your reply.\n\n'
    rm -f "$drained"
  fi
fi

# ── 2. Memory recall ─────────────────────────────────────────────────
# Slash commands and short chat ("ok", "thanks", "继续") don't need memory.
# Anything else gets the top hits' L0 lines; the agent reads more with
# memory_get. Never blocks or fails the prompt. Skipped in auto mode, where
# the prompt is the expanded tick orchestrator, not the user's words.
if [[ "${MEMORY_ENABLED:-1}" = "1" && -n "${MEMORY_API_URL:-}" && "$PROMPT" != /* \
      && ! -f "$HOME/.claude/.harness_active" ]]; then
  python3 - "$PROMPT" <<'PY' || true
import json, os, sys, urllib.request
prompt = sys.argv[1].strip()
if len(prompt) < 12:
    sys.exit(0)
body = json.dumps({
    "username": os.environ.get("USERNAME", ""),
    "project_path": os.environ.get("CLAUDE_PROJECT_DIR", "/workspace"),
    "query": prompt[:500],
    "limit": 3,
}).encode()
req = urllib.request.Request(
    os.environ["MEMORY_API_URL"] + "/memory/search", data=body,
    headers={"content-type": "application/json"},
)
try:
    hits = json.load(urllib.request.urlopen(req, timeout=2))
except Exception:
    sys.exit(0)
if not hits:
    sys.exit(0)
print("[Memory recall — possibly relevant; read with memory_get(id) if useful]")
for h in hits:
    print(f"- [{h['dir_key']}] {h['name']}: {h['description']} ({h['memory_id']})")
print()
PY
fi
}

CONTEXT="$(route)"
[[ -n "$CONTEXT" ]] || exit 0
python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": sys.argv[1]}}))' "$CONTEXT"
