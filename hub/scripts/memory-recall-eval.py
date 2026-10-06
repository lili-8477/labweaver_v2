#!/usr/bin/env python3
"""Phase 3 gate: Recall@5 on an evaluation set, plus session-start index size.

Eval set: JSONL, one question per line —
  {"username": "alice", "project_path": "/workspace/pbmc3k",
   "query": "what QC thresholds did we settle on?",
   "expected": ["<memory_id>", ...]}
project_path is optional. Recall@5 for a question is the share of its expected
ids in the top 5 search hits; the gate is mean >= 0.8 over 50 questions and
every session-start index <= 800 tokens (chars / 4, same heuristic as the API).

Usage: MEMORY_API_URL=http://localhost:8400 memory-recall-eval.py eval.jsonl
Search no longer mutates hit counts, so running this is side-effect free.
"""
import json, os, sys, urllib.parse, urllib.request

API = os.environ.get("MEMORY_API_URL", "http://localhost:8400")
K, RECALL_GATE, TOKEN_GATE = 5, 0.8, 800


def call(path, body=None):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req, timeout=10))


def main(path):
    cases = [json.loads(l) for l in open(path) if l.strip()]
    recalls = []
    for c in cases:
        body = {"username": c["username"], "query": c["query"], "limit": K}
        if c.get("project_path"):
            body["project_path"] = c["project_path"]
        got = [h["memory_id"] for h in call("/memory/search", body)]
        want = set(c["expected"])
        r = len(want & set(got)) / len(want)
        recalls.append(r)
        if r < 1:
            print(f"miss  recall={r:.2f}  {c['query'][:70]!r}")

    mean = sum(recalls) / len(recalls)
    print(f"\nRecall@{K}: {mean:.3f} over {len(cases)} questions (gate >= {RECALL_GATE})")

    worst = 0
    for user, proj in sorted({(c["username"], c.get("project_path") or "/workspace") for c in cases}):
        qs = urllib.parse.urlencode({"username": user, "project_path": proj})
        ctx = call(f"/memory/context?{qs}")
        tokens = len(ctx["system_prompt"]) / 4
        worst = max(worst, tokens)
        print(f"session-start index  {user} {proj}: ~{tokens:.0f} tokens")
    print(f"largest index: ~{worst:.0f} tokens (gate <= {TOKEN_GATE})")

    sys.exit(0 if mean >= RECALL_GATE and worst <= TOKEN_GATE else 1)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
