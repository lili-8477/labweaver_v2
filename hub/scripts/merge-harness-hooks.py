#!/usr/bin/env python3
"""Merge the harness hook entries into a user's settings.json.

Usage: merge-harness-hooks.py <settings.json>

Idempotent: overwrites only the harness-managed event keys. Writes in place
(no atomic rename) to preserve the inode, since the file is bind-mounted
into the user's container.

Tool matchers list both spellings: Claude Code names its tools Bash/Write/Edit,
DeepSeek Harness names them bash/write/edit, and both match case-sensitively.
"""
import json
import pathlib
import sys

HOOKS_DIR = "$HOME/.claude/hooks"


def command(script):
    return {"hooks": [{"type": "command", "command": f"{HOOKS_DIR}/{script}"}]}


HARNESS_HOOKS = {
    "SessionStart": [command("memory_session_start.sh")],
    "UserPromptSubmit": [command("userprompt_route.sh")],
    "PreToolUse": [
        {"matcher": "Bash|Write|Edit|bash|write|edit", **command("pretool_audit.sh")},
    ],
    "PostToolUse": [
        {"matcher": "Write|Edit|write|edit", **command("posttool_commit.sh")},
        {"matcher": "Bash|bash", **command("posttool_jobid.sh")},
    ],
    "Stop": [command("stop_tick.sh")],
}

p = pathlib.Path(sys.argv[1])
cur = json.loads(p.read_text())
hooks = cur.setdefault("hooks", {})
hooks.update(HARNESS_HOOKS)
order = list(HARNESS_HOOKS)
cur["hooks"] = {k: hooks[k] for k in order} | {k: v for k, v in hooks.items() if k not in order}
with p.open("w") as f:
    json.dump(cur, f, indent=2)
    f.write("\n")
