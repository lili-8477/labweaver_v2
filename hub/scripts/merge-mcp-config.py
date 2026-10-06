#!/usr/bin/env python3
"""Register the labweaver-memory MCP server in a user's .mcp.json.

Usage: merge-mcp-config.py <.mcp.json> <username> [memory_api_url]

Creates the file if missing; keeps any other servers. Idempotent: the
labweaver-memory entry just overwrites itself. The adapter passes these
servers to DeepSeek Harness when it opens a session.
"""
import json
import pathlib
import sys

p, username = pathlib.Path(sys.argv[1]), sys.argv[2]
memory_api_url = sys.argv[3] if len(sys.argv) > 3 else "http://labweaver-indexer:8400"

try:
    cur = json.loads(p.read_text() or "{}") if p.exists() else {}
except json.JSONDecodeError:
    cur = {}
cur.setdefault("mcpServers", {})["labweaver-memory"] = {
    "command": "labweaver-memory-mcp",
    "env": {"USERNAME": username, "MEMORY_API_URL": memory_api_url},
}
with p.open("w") as f:
    json.dump(cur, f, indent=2)
    f.write("\n")
