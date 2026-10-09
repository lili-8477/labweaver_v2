# Q&A Log

Append-only log of learning-oriented questions about labweaver.
Newest entries at the bottom. See repo `CLAUDE.md` principle 3.

---

## 2026-04-27 — How does scSurvival load into a notebook? Is the local venv used?

**Q:** How is the venv at `/home/lili/labweaver/hub/workspaces/li86/local_projects/scsurvival/venv` loaded into an ipynb? Or is scSurvival installed somewhere else?

**A:** The local venv is **not** loaded by any notebook. scSurvival is installed into the image-bundled `/venv` as a PEP 660 editable install whose `.pth` redirects imports to the project source.

Concrete chain:

- The container registers only two Jupyter kernels: `python3` → `/venv/bin/python` and `ir` → system R. Nothing points at `local_projects/scsurvival/venv`.
- Inside `/venv/bin/python`, `import scSurvival` resolves to `/workspace/local_projects/scsurvival/repo/scSurvival/__init__.py`.
- The redirection lives at `/venv/lib/python3.12/site-packages/__editable__.scsurvival-1.3.0.pth` — created by `pip install -e .` run from `/venv/bin/pip` against `local_projects/scsurvival/repo`.
- The orphan venv at `local_projects/scsurvival/venv` was itself spawned by `/venv/bin/python -m venv …` (per its `pyvenv.cfg`) but never registered as a kernel, so no notebook touches it.

Mental model:

- One container = exactly two kernels by design (`python3`, `ir`). Don't add more — `metadata.kernelspec.name` outside that set fails on first execute.
- To add a Python package for notebooks, install into `/venv` (`/venv/bin/pip install <pkg>`). The bundled `/venv` is chowned to `node` at container start so runtime installs persist in the container's overlay (NOT the image).
- For live development of a package, use editable install (`pip install -e ./path/to/repo`) — package metadata lives in `/venv`, sources stay in the project tree, edits show up without reinstall.
- "Package metadata in `/venv`, sources in the project" is what makes a project-local venv look load-bearing when it isn't.

Cleanup hint: `rm -rf local_projects/scsurvival/venv` is safe — nothing depends on it.

---

## 2026-04-27 — Shared vs user CLAUDE.md: which dominates?

**Q:** We have 2 layers of CLAUDE.md (shared, user). What is dominating?

**A:** Neither — there is no runtime layering. Only the user's CLAUDE.md is loaded.

Mechanics:

- `hub/scripts/add-user.sh` copies `shared/CLAUDE.md` → `<user>/CLAUDE.md` once at provisioning, only if the user doesn't already have one. After that the two files are independent.
- The container bind-mount list mounts `<user>/CLAUDE.md` → `/workspace/CLAUDE.md`. `shared/CLAUDE.md` is not mounted; only `shared/reference`, `shared/projects`, `shared/skills` are.
- Claude Code discovery walks up from `cwd=/workspace` to `/`. Nothing exists above, so `/workspace/CLAUDE.md` is the only CLAUDE.md the SDK sees.

Consequence: edits to `shared/CLAUDE.md` don't propagate to existing users. You either re-`cp` after each edit, or use Claude Code's `@path` import to point the user CLAUDE.md at a shared file mounted into the container (the standard "shared base + user override" pattern).

Three plumbing options if true layering is wanted:

1. **Template + manual re-sync** (status quo): `cp shared/CLAUDE.md <user>/CLAUDE.md` after each template edit. Cheapest. Overwrites user-local edits.
2. **`@include` at runtime**: bind-mount `shared/CLAUDE.md` to e.g. `/workspace/.labweaver/shared.md`; user CLAUDE.md begins with `@/workspace/.labweaver/shared.md`. Live updates, user file owns local overrides. Modest add-user.sh change.
3. **Concat at boot**: entrypoint composes shared+user → /tmp file, mounts that. More machinery, same outcome as option 2.

---

## 2026-04-27 — What is `@include` in CLAUDE.md? How does it work?

**Q:** What is `@include`? How does `@include` work?

**A:** Claude Code's memory-import syntax. Writing `@<path>` inside `CLAUDE.md` (or any memory file) inlines the referenced file's contents into the system prompt when Claude Code loads memory at the start of a turn.

Syntax (note: examples below are inside a code fence so the importer ignores them — the parser skips fenced/backticked text):

```
@/workspace/.labweaver/shared.md      # absolute path
@./team/style-guide.md              # relative to this CLAUDE.md
@~/dotfiles/global-claude.md        # home-relative
```

Mechanics:

- The import is recursive — an included file can include others, depth-capped (~5 levels).
- Relative paths resolve against the importing file's directory.
- Imports are skipped inside fenced code blocks and inline backticks, so the syntax itself can be documented without firing.
- Re-evaluated every turn (CLAUDE.md is re-read), so edits to imported files take effect on the next user message — no restart.
- It's an *inline* mechanic, not a layered override system. Imported text and surrounding text concatenate into the same system prompt. To "override" the imported content, place user-specific instructions *after* the `@…` line so the later text wins.
- Imported files are plain markdown — not skills. For skill-style routing, use `.claude/skills/` instead.

LabWeaver application: bind-mount `shared/CLAUDE.md` into each container at e.g. `/workspace/.labweaver/shared.md`, seed each user's `CLAUDE.md` with `@/workspace/.labweaver/shared.md` as the first line, and shared edits will flow live to every workspace while user files own local overrides.

---

## 2026-04-27 — Why didn't `nginx -s reload` pick up my edited nginx.conf?

**Q:** I edited `hub/nginx.conf` on the host, ran `docker exec ... nginx -s reload`, and the new `location /upload/` block didn't take effect — uploads still hit the catch-all and returned 405. The host file clearly had my changes. What was going on?

**A:** Linux bind-mounts of *single files* (not directories) bind to the **inode**, not the path. Many editors — including Claude Code's Edit/Write tools — implement an "atomic write" by writing a sibling temp file and renaming it over the target. The rename gives the path a new inode; the original inode is unlinked from the host directory entry but stays alive because the container still has it open via the bind mount.

So:
- The host's `hub/nginx.conf` correctly had the new content (new inode).
- The container's `/etc/nginx/nginx.conf` was still pointing at the **old, now-orphaned inode** with the old content.
- `nginx -s reload` re-read its config — but it re-read the *old* file, since that's what the bind mount still resolved to.

`docker logs labweaver-nginx` confirmed it: `wc -l /etc/nginx/nginx.conf` inside the container reported 99 lines, while the host file was 145. `ls -la` inside the container showed an mtime from days earlier — a clear inode-swap fingerprint.

**Fix:** `docker restart <container>`. Restart re-resolves bind sources by path, so the new inode gets picked up.

**Avoid in the future:**

- For config files that change often, prefer bind-mounting the **parent directory** instead of the single file. Directory bind-mounts resolve children by name on each access, so atomic-rename edits work transparently.
- Or treat any `Edit`/`Write` of a bind-mounted file as needing a `docker restart`, not just a config reload.
- The same trap applies to `docker cp` in reverse — copying *over* a bind-mounted file inside the container won't propagate to the host either, because the container's overlay shadows the bind source.

This burned roughly 15 minutes of upload-feature debugging today; the symptom (`405 Method Not Allowed` on `PUT /upload/...`) led me on a wild goose chase through frontend XHR code, nginx variable resolution, and adapter method handling before the inode mismatch became visible.

---

## 2026-05-07 — How does the labweaver agent memory system work end-to-end?

**Q:** Summarize how memory system works.

**A:** Three layers, each owned by one process. Capture is server-side (no per-event hooks); retrieval has three surfaces (agent MCP, SessionStart hook, frontend panel); audit + soft-delete + restore are all transactional.

**Capture — two paths, both write through the same `insertMemoryRow` helper in `hub/indexer/src/distiller-repo.ts`.**

1. *Distillation (auto).* `distiller.ts` polls `sessions WHERE last_active < now() - 5min` every 60 s, streams JSONL via `path-decode.ts` + `transcript-reader.ts`, calls `claude-haiku-4-5` with a versioned prompt, writes one `session_summary` + 0–N `observation` rows. Idempotent by `(username, project_dir, type, content_hash)` UNIQUE.
2. *User writes.* `/memorize` (chat slash command) → `labweaver-memory` MCP server (`mcp-memory/src/index.ts`) → adapter NATS RPC `memory_write` → `POST /memory/write` → `writeUserMemory()`. Frontend panel writes go through the same NATS-RPC bridge.

**Storage — Postgres, migrations 0006–0009.**

| Table | Purpose |
|---|---|
| `memories` | One row per memory: `(memory_id, username, project_dir, type, source, name, description, body, content_hash, hit_count, last_hit_at, deleted_at, ...)`. UNIQUE on `(username, project_dir, type, content_hash)`. |
| `memory_chunks` | One row per chunk: `content`, `tsv` (FTS), `embedding vector(384)`. HNSW + GIN indexes. |
| `memory_facets` | Open `(key, value)` tags: gene/dataset/tool/pipeline/file. |
| `embedder_queue` | Work queue. Indexer's embedder loop polls 64 chunks every 5 s, batches them to the `labweaver-embedder` Python sidecar (bge-small-en-v1.5), writes vectors back. |
| `memory_distill_cursor` | Per-user `last_seen_session_last_active` watermark. |
| `memory_audit_log` (sub-phase C) | Every mutation appends a row in the *same transaction*. JSONB `before`/`after`. FK CASCADE. |

Scope tier is computed: `username='__org__'` → org, `project_dir IS NULL` → user, else project. No separate scope column.

**Retrieval — three surfaces.**

1. *Agent (in-session).* MCP tools `memory_search/get/timeline/write/forget` over stdio. Search returns `{memory_id, snippet ≤200 chars, score}` only — agent calls `get` on demand. Token-efficient pattern from claude-mem.
2. *SessionStart hook.* `memory_session_start.sh` curls `GET /memory/context?username=&project_path=&budget_tokens=2000`. Server runs scope×popularity×recency ranking (no FTS), packs ≤50 memories until budget hits, returns one `system_prompt` string. Hook stdout is injected as system context by Claude Code.
3. *Frontend Memory panel.* `MemoryPanel.vue` → pinia store → `memoryService` → adapter NATS RPC `memory_search/get/list/write/update/forget/restore/audit` → `MemoryRpcClient` HTTP → `memory-api.ts`. Frontend never sees `username`; the adapter injects its trusted `process.env.USERNAME`.

**Search ranking** (`searchMemories` in `memory-repo.ts`): hybrid SQL — `0.7×vector_cosine + 0.3×ts_rank`, then multiplied by scope-specificity (`project=1.20, user=1.10, org=1.00`), popularity (`1 + ln(1+hit_count)×0.05`), and recency (`exp(-age_seconds / (90 days))`). Embedder down → FTS-only fallback. Returned IDs get `hit_count++` in a follow-up `UPDATE`.

**Audit + soft-delete (sub-phase C).** Every mutation is `pool.connect → BEGIN → SELECT FOR UPDATE → checks → UPDATE → appendAudit(action, before, after) → COMMIT`. Negative paths ROLLBACK without auditing. Soft-delete sets `deleted_at`; default reads filter it out. Restore clears it. Per-memory audit trail is owner-only (`GET /memory/:id/audit`). `GET /memory/metrics` returns counts/queue/cursor lag for ops debugging.

**Trust model.** `USERNAME` is the tenant key, set by `add-user.sh` from the workspace prefix, never user-controlled at runtime. The frontend carries no username; the adapter injects it. The memory-api itself has no auth (private docker network, same model as the postgres bridge in Phase 2). Org writes are operator-only — the MCP tool surface excludes `scope:'org'`.

**Out of scope (deferred):** paid embeddings (swap `EMBEDDER_URL`), subagent-scoped memory, cross-memory audit explorer, bulk forget, editing distilled rows.

## 2026-05-11 — Running scbench in labweaver

**Q:** I want to run the benchmark https://github.com/latchbio/scbench in my labweaver platform. How should I proceed?

**A:** scbench is an agentic-eval harness — 394 graded scRNA-seq tasks (only 7 canonical ones public; rest withheld to prevent training contamination). Each task ships an `.h5ad` + prompt + deterministic grader; the agent writes `eval_answer.json` and the runner grades it. It has a CLI (`scbench run --agent minisweagent --model anthropic/claude-opus-4-7`) and an `EvalRunner` API with a pluggable `agent_function(task_prompt, work_dir) → dict`.

Strategic question: what does "run it on labweaver" mean? Three flavors of integration, from easiest to most informative:

1. **Bundled agent (smoke test).** `pip install -e scbench` inside a user container, run canonical tasks with `--agent minisweagent`. Validates the image's bio stack (`pantheon-agents-sc` already has scanpy + R/Seurat/scDblFinder). Does not exercise the platform — only model + their loop.
2. **Custom `agent_function` via Anthropic SDK directly** with labweaver's tool surface. Tests tooling choices, still skips the NATS/adapter/UX path.
3. **`agent_function` that dispatches into the adapter over NATS** — labweaver becomes the agent under test, scbench is the outer driver. Exercises session lifecycle, hooks, MCP-memory, kernel bridge. Most informative, most plumbing.

Suggested order: do (1) as a 30-min smoke test in `labweaver-li86`, then decide if (2) or (3) earns its complexity.

Two integration gotchas either way:

- **`work_dir` / cwd alignment** — agent must write `eval_answer.json` into the runner-supplied `work_dir`. LabWeaver sessions default cwd to `/workspace` or `local_projects/<proj>/`. Easiest: make `work_dir` a subdir of `local_projects/scbench-runs/<task-id>/` so the agent's `Write` lands there.
- **Dataset cache** — `.h5ad` snapshots are downloaded; cache on the bind-mounted workspace, not `/tmp`, or every container recreate re-downloads.

For the full 394 set (vs. 7 canonical), contact LatchBio.

## 2026-05-11 — Does scbench run automatically or do I drive it from the UI?

**Q:** When I run a scbench eval, does the test run automatically, or do I tell the agent to do it in the labweaver UI?

**A:** Automatic. `scbench run --agent minisweagent --model anthropic/...` is a self-contained loop: parse task → `latch cp` data → spawn `minisweagent` (calls Anthropic API directly with bash/python tools in a sandbox) → write `eval_answer.json` → grade. **No NATS, no labweaver adapter, no UI session.** The labweaver container's only role is providing the bio stack (scanpy/R/etc.) that the agent's bash tool uses.

The three integration flavors from the earlier entry map to how much of labweaver is exercised:

| Flavor | Driver | Agent loop | UI? | Tests |
|---|---|---|---|---|
| (1) `--agent minisweagent` | scbench CLI | minisweagent → Anthropic API | No | Model + image bio stack |
| (2) Custom `agent_function` | scbench CLI | Your Python → Anthropic SDK | No | Model + your tools |
| (3) `agent_function` over NATS | scbench CLI | RPC → labweaver adapter → Claude Code session | No (programmatic) | Full labweaver stack |

A "manual UI" side experiment — pasting the task prompt into a labweaver chat and eyeballing the answer — is possible but isn't a scbench mode; the runner won't grade it.

## 2026-05-11 — How scbench tasks are designed

**Q:** I would like to learn more about how the tasks are designed.

**A:** Every task is one JSON file with four logical parts: identity (`id`), prompt (`task` — self-contained, including the exact JSON schema the agent must write to `eval_answer.json`), inputs (`data_node` Latch URIs), and a deterministic grader (`type`+`config`). Plus author-only `notes` and a `metadata` block.

The grader is the design bottleneck. Only answer-shapes that fit one of five families can become tasks:

| Grader | Answer | Pass test | Trade-off |
|---|---|---|---|
| `numeric_tolerance` | float(s)/int(s) | every field within abs/rel tolerance | cheapest signal; flattens biology to a number |
| `multiple_choice` | string from a set | exact match | useful for interpretation questions, no nuance |
| `label_set_jaccard` | set of labels | Jaccard ≥ pass_threshold (e.g. 0.8) | tolerates partial credit; threshold is brittle |
| `marker_gene_precision_recall` | gene list | P@K, R@K ≥ threshold | realistic for DE/marker tasks; sensitive to gene-symbol spelling |
| `distribution_comparison` | proportions | distribution distance < tol | cell-type fractions, batch tests |

Free-form scientific judgment isn't gradable here. This is a deliberate trade — code graders are cheap, stable, reproducible (vs LLM-judges which drift and cost per grade).

`metadata.eval_type` is the design axis between judgment and adherence:

- **`scientific`** — prompt asks for a judgment call (e.g. *"choose conservative QC thresholds"*). Grader is a tolerance window around an expert answer. Tests biological judgment.
- **`procedural`** — prompt prescribes a recipe step-by-step (PCA components, Leiden resolution, k for kNN). Grader checks the recipe's expected output. Tests faithful execution. The snrna celltyping task we ran is procedural; both Sonnet and Opus failed at Jaccard 0.714 because the prescribed `Leiden res=0.6 + cluster-majority-vote` genuinely cannot surface Macrophage/Mural — author seemingly knew this (notes: *"dataset may lack some labels"*) and set `pass_threshold=0.8` to allow exactly one missing label, no more.

`metadata.time_horizon` (small/medium/large) is a tool-turn budget proxy. Tolerance tuning is the hardest authoring step (note in the QC task: *"Threshold set to 1.5% of the total cells to allow for some variation"* — explicit expert-variance calibration).

Public/private split: 30 canonical tasks are public, 364 are withheld to prevent training contamination. Published leaderboard numbers (Opus 4.6 = 52.8%) are over the full 394 — observed pass/fail on the canonical 30 is **not** representative; they're the showpieces.

Repo refs: `docs/specification.md` (JSON spec), `docs/adding_evals.md` (authoring), `paper/main.pdf` (rationale), `scbench/types.py` (`TestCase` model), `latch_eval_tools/graders/` (implementations).

## 2026-05-12 — `grub-reboot` vs `grub-set-default`

**Q:** what is grub reboot for

**A:** `grub-reboot` stages a **one-shot** boot override. It writes `next_entry=X` into `/boot/grub/grubenv`; GRUB consumes that on the next boot and clears it, so subsequent boots return to `GRUB_DEFAULT`.

Contrast with `grub-set-default`, which writes `saved_entry` and persists until changed. Use `grub-reboot` when you want to boot a non-default kernel *once* — e.g. temporarily falling back to 6.8.0-110 because the running 6.8.0-111 has no matching `linux-modules-nvidia-590` package yet. Auto-updates can later put you back on the newest kernel without a manual revert.

Caveat: requires `GRUB_DEFAULT=saved` (or equivalent) in `/etc/default/grub`. Ubuntu defaults to this; a hardcoded `GRUB_DEFAULT=0` silently ignores the override.

## 2026-05-13 — Claude Code login: how the auth flows from `claude /login` to a spawned subprocess

**Q:** How does the "logged-in" auth work for Claude Code, especially when it's invoked as a subprocess (like the labweaver adapter does)?

**A:** OAuth, with the token persisted to a single JSON file.

1. `claude /login` opens a browser to console.anthropic.com, you grant access, Anthropic returns a long-lived **refresh token** + short-lived **access token**.
2. Both are stored in `~/.claude.json` (mode 0600). No env var, no daemon — just the file.
3. Every spawn of `claude` (interactive or via subprocess) reads `~/.claude.json`, refreshes the access token if expired, and attaches `Authorization: Bearer <access>` to its API calls.
4. **Precedence**: `ANTHROPIC_API_KEY` env var wins if set (→ API billing); otherwise the `.claude.json` OAuth tokens are used (→ Max plan billing); otherwise it prompts for login. This is why a stray `ANTHROPIC_API_KEY` in a container's env can silently flip the whole platform off your Max subscription.
5. **Persistence in this stack**: `.claude.json` lives in each workspace container's writable overlay (not in a bind mount). It survives `docker restart` but is wiped by `docker rm` + `docker run`. To make it survive recreates, bind-mount `~/.claude.json` from the host the same way `settings.json` already is.

## 2026-05-22 — Porting labweaver to an HPC where only Singularity is available

**Q:** The backend service is based on docker containers. If I want to move all the infra to CHPC, where only Singularity is available, will the design still work?

**A:** Technically possible; the application code is portable, but three pieces of the design need rework and one (per-user long-running workspaces) fights HPC conventions.

What ports cleanly: images convert via `singularity build foo.sif docker-archive://...`, bind mounts are 1:1, `--nv` replaces `--gpus all`, no source changes to the adapter / indexer / frontend.

What needs rework:
1. **Networking.** Singularity has no daemon-managed bridge. Today the stack relies on Docker DNS (`labweaver-postgres`, `labweaver-nats`). Replace with `127.0.0.1:<port>` on a single node, or explicit hostnames over the cluster interconnect.
2. **Orchestration.** No `docker-compose` equivalent. `singularity instance start <sif> <name>` is the closest, but with no dependency ordering, health checks, or restart policy. Replace `hub/docker-compose.yml` with a SLURM job, a startup shell script, or `singularity-compose`. The per-user spawn in `recreate-user.sh` becomes a `singularity instance start` call.
3. **Per-user long-running containers.** HPC schedulers expect time-bounded jobs, not always-on user services. Either run workspaces inside interactive SLURM sessions (they die with the job) or flip to ephemeral workspaces with state on NFS.

Pragmatic split: keep shared infra (postgres, nats, indexer, embedder, frontend proxy) on a small always-on VM *outside* HPC, and use HPC only for the per-user workspace containers that run scanpy/Seurat — they reach the shared services over the cluster's outbound network. Preserves the architecture without forcing HPC to act like a Docker host.

Site-specific blockers to verify at CHPC: long-running Singularity instances on login nodes vs job-only; whether any user-facing port is exposed at the cluster perimeter (needed for frontend ingress); NFS write performance for postgres' data dir (NFS-hosted postgres is usually unhappy).

## 2026-05-23 — Per-chat context isolation and resume

**Q:** How does the agent manage context when I switch between different sessions?

**A:** Per-chat isolation backed by Postgres-tracked Claude SDK session UUIDs.

- Each LabWeaver chat row has a `session_id` column = the real Claude Agent SDK
  session UUID. One UUID ↔ one JSONL transcript at
  `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
  (bind-mounted from `${WORKSPACE}/.claude/claude-projects/` so it
  survives container recreate). Switching chats in the sidebar just loads
  a different transcript.
- On every turn, the adapter (`adapter/src/rpc.ts` → `runChat`) reads the
  chat row and passes `resumeSessionId: chat.session_id` to the SDK,
  which reconstructs the model's view from the JSONL. First turn of a
  fresh chat has no UUID yet — the SDK mints one and `onSessionId`
  back-fills it for the next resume.
- `cwd` stays at `defaultProjectCwd` (`/workspace`) even when the chat is
  bound to a project, because the JSONL path is derived from the cwd
  encoding; changing it mid-chat would split the transcript and break
  resume. The agent learns its project from the kickoff prompt / `/tick`
  harness, not from `cwd`.
- Concurrency: `ChatMutexRegistry` allows one streaming turn per chat,
  but chats run in parallel. You can switch and watch another chat while
  the first runs.
- What is NOT shared between sessions: the JSONL transcripts themselves.
  Cross-session knowledge only flows via: (1) the labweaver-memory MCP
  (auto-injected at session start by `memory_session_start.sh`),
  (2) files in `/workspace/` that all chats can read, (3) `CLAUDE.md` +
  the imported shared `CLAUDE.md`, (4) skills under `~/.claude/skills/`.
- Inside a single long session, the Claude harness automatically
  compresses older messages when the model context fills up — the full
  JSONL on disk is preserved, only the in-memory view is summarized.

## 2026-05-23 — Per-workspace CHPC UNID vs container UID

**Q:** For each container, do I need to set a fixed UID for CHPC access?

**A:** Two separate identifiers, often confused:

- **Container Linux UID** (`node` = 1001) is set once in `image/Dockerfile` (`ARG UID=1001`) and is shared by every workspace. It has to match the host UID that owns the bind-mounted dirs, so don't vary it per user.
- **CHPC UNID** (e.g. `u6025146`) is the researcher's identity on CHPC. It lives in `hub/workspaces/<workspace>/.ssh/config` on the `User` line, one per workspace, and survives `recreate-user.sh` because `.ssh` is a bind mount.

So the answer is "yes, per workspace, but it's the CHPC UNID, not a Linux UID." Today it's a manual edit after `add-user.sh`; a `--chpc-unid <unid>` flag on `add-user.sh` would `sed` the placeholder at provision time — same shape as the existing `--data` flag.

## 2026-05-27 — How does the new CHPC job notification system work in plain language?

**Q:** How it works in plain language

**A:** Three small bash scripts and one hidden file form a loop between two worlds: a background poller and the chat.

The cast:

- `posttool_jobid.sh` — Claude Code's PostToolUse hook on Bash. Fires every time the agent runs a Bash command. See `hub/skeleton/harness/hooks/posttool_jobid.sh`.
- `chpc_job_watcher.sh` — a tiny per-jobid poller. See `hub/skeleton/harness/hooks/chpc_job_watcher.sh`.
- `userprompt_route.sh` — Claude Code's UserPromptSubmit hook. Fires every time the user types anything. See `hub/skeleton/harness/hooks/userprompt_route.sh`.
- `~/.claude/.chpc_pending` — a mailbox file (NDJSON).

The flow:

1. The agent runs `ssh chpc-login 'sbatch ...'`. CHPC prints a jobid (e.g. `13169761`).
2. The Bash command finishes → `posttool_jobid.sh` runs. It recognizes `sbatch`, extracts the jobid, and launches `chpc_job_watcher.sh <jobid>` **in the background, detached** (`setsid nohup ... &`). The watcher keeps running after the hook ends and after the agent's turn ends.
3. The agent ends its turn. The chat goes idle. The user walks away.
4. The watcher polls CHPC every 10 minutes: `ssh chpc-login 'sacct -j <jobid> ...'`. Bounded at 72h; protected by a per-jobid flock so duplicate watchers can't fight. Interval tunable via `CHPC_POLL_INTERVAL` env var (seconds).
5. Eventually CHPC returns a terminal state (`COMPLETED`/`FAILED`/`TIMEOUT`/`OOM`/...). The watcher appends one JSON line to `.chpc_pending` and exits.
6. Hours later, the user types anything. Before that prompt reaches the model, `userprompt_route.sh` runs. It atomically rotates `.chpc_pending` to a tmpfile (so a watcher writing at that instant isn't lost), formats the contents as a "events since your last prompt" block, and emits it on stdout — which Claude Code prepends to the user's message as additional context.
7. The agent sees `job 13169761 → COMPLETED` glued on top of the user's message, reads the log files, folds the outcome into its reply.

The mental model: the watcher (background, hours-long) and the chat (foreground, idle) never talk directly — the mailbox file is the only bridge. The watcher only writes; the prompt hook only reads-and-clears.

What it deliberately doesn't do: it doesn't wake the chat. No notification, no auto-resume. If the user never sends another message, the agent never learns. That trade-off was the explicit Option A choice (vs. an autonomous variant that would inject a synthetic prompt via the adapter's `chat` RPC over NATS) — passive saves API tokens and avoids racing the user, at the cost of "you have to type for the agent to find out."

## 2026-06-16 — Skill preview vs. edit: why preview is read-only

**Q:** i can preview only, then what is the update for? agent can edit it, right?

**A:** Yes. The Skills panel separates *editing* from *publishing*:

1. **Edit** — happens in chat. You ask the agent to modify `~/.claude/skills/<name>/SKILL.md` (or any file in the skill folder); Claude uses Edit/Write tools directly on disk. You can also edit in a terminal — same file.
2. **Preview** (the inline expander, [`frontend/src/components/skills/SkillRow.vue`](../frontend/src/components/skills/SkillRow.vue)) — read-only view of what's currently on disk. Its only job is to let you verify what *would* be submitted before you press the button.
3. **Submit update / Share** — the button calls `share.submit({ kind: 'skill_update' | 'skill', ref: name })` ([`frontend/src/stores/skills.ts`](../frontend/src/stores/skills.ts)). The share-api snapshots the current SKILL.md + files and queues a request for the org reviewer. On approve, `/workspace/shared/skills/<name>/` is atomically replaced.

The split keeps the UI surface tiny — no in-browser editor, no save-vs-submit confusion — and reuses the chat's already-trusted editing path (with hooks, audit, etc.) rather than building a second one in the panel.

## 2026-10-06 — Auto mode vs DeepSeek Harness built-ins, and trajectory quality

**Q:** Critically comment on the auto mode. Is it overlapped with DeepSeek Harness? For some data-analysis tasks I want to keep a nice trajectory for memory and skill distillation.

**A:** Yes, at the engine layer. The `acp` profile already mounts `dsh-goal` + `dsh-goal-round-driver` (a persistent objective with a round cap that survives resume and restarts, plus pause/block), `subagent`, `workflow` (deterministic JS orchestration over subagents), `todo` and `plan-mode`. Our `dsh-plugins/tick.js` is a thin re-implementation of the round driver. The domain layer does not overlap and is the part worth keeping: pipeline templates, numeric gates, an independent reviewer, `progress.md` with git commits, and the retrospective.

The bigger problem for distillation is *where the trajectory lands*:
- The real work (scripts, errors, retries) happens in subagent child sessions. dsh-acp streams only the parent session (`ownsSession` filter), so the Claude-format transcript the indexer reads holds orchestrator chatter, not the analysis.
- Every round re-sends the full tick.md, so the parent history is mostly copies of the routing prompt.
- Routing rules 0–6 are a pure function of `progress.md`, yet an LLM call makes the decision on every round.
- Token usage skips the subagents, where most of the spend is.

Recommendations:
1. Capture child sessions as `isSidechain: true` transcript lines through a small dsh plugin, like `usage.js`.
2. Make each step a structured record: inputs, script, gates, verdict, attempts. Extend the reviewer's `project/trajectories` writes; this, not the chat log, is the distillation source.
3. Move routing into code (the tick plugin reads `progress.md` and names the next agent and work item), keeping LLMs for bootstrap/plan/execute/review.
4. Adopt `dsh-goal` for the loop only once the adapter can stream rounds that start outside an ACP prompt. Until then, `tick.js` is the pragmatic choice.

See `adapter/dsh-plugins/tick.js`, `hub/skeleton/harness/commands/tick.md`, `hub/skeleton/harness/agents/tick-reviewer.md` step 7.

## 2026-10-07 — Do we need auto mode and the tick subagents?

**Q:** Do we need self-driving mode and the subagents?

**A:** The loop, yes, if users run multi-step pipelines unattended; the five subagents, no. Since routing moved into `tick.js` (`nextStep`), the parent turn only relays: each round it reads an agent file and calls `subagent`. That's a model call that adds nothing. It also forces the real work into child sessions, which is the only reason `sidechain.js` exists.

What each subagent buys:
- **reviewer**: a fresh context that never sees the executor's reasoning. This is the one real reason for a subagent. Keep it.
- **executor**: a fresh context per step, which keeps long projects from filling the parent context. dsh compaction covers that. Without the subagent, the analysis lands in the main transcript, which is better for distillation.
- **bootstrap + planner**: two sequential one-shot steps. Merge them, or let the main agent do them.
- **retrospective**: a single memory pass at the end. The main agent can do it.

Leaner shape: `tick.js` steers the main agent with the work item ("do step X; follow `tick-executor.md`"), and the main agent dispatches only `tick-reviewer` as a subagent. Implemented the same day; verified in the UI on a 2-step project (one main transcript, one reviewer sidechain per step). See `adapter/dsh-plugins/tick.js`, `hub/skeleton/harness/commands/tick.md`.

## 2026-10-07 — Move the LabWeaver UI onto the DeepSeek Harness web UI?

**Q:** I want to refactor the current UI to the DeepSeek Harness UI. Does it make sense? I need to keep the LabWeaver brand (logo, color scheme, font).

**A:** Branding is not the obstacle. dsh's web UI takes its logo from a swappable plugin, `dsh-client-ui-brand-official`, and its colors and fonts from roughly 108 `--dsw-*` CSS variables, including `--dsw-font-family-brand`. A LabWeaver brand plugin plus one variable override layer covers it.

The real cost is porting everything else. Every LabWeaver panel would be rewritten from Vue into React plugins for dsh's web UI: auto-mode checklist, files and h5ad viewer, notebook, memory, skills and share review, the CHPC pill, drag-and-drop projects, next-step chips. The adapter's RPCs would become dsh server plugins. Multi-user routing (nginx, plus a NATS service per user, plus chats in Postgres) would have to be rebuilt around one `dsh web` server per user container. On top of that, dsh is still at 0.2.0-rc.2, and plugins are told to re-check its plugin interfaces before relying on them.

You would gain dsh's own views of its features (subagents, workflows, goals, plan mode, approvals, jobs, terminal) kept current with the engine at no cost, and the ACP translation layer would shrink.

Recommendation: no big-bang rewrite yet. Keep the thin bridge that hosts dsh web plugins inside LabWeaver (commit `af19aec`). If the idea stays attractive, first run a short spike: `dsh web` with a LabWeaver brand plugin, plus one ported feature (the auto-mode checklist). Then decide using the measured cost, and once dsh's plugin interfaces are stable.

## 2026-10-08 — Can dsh Agent Teams be switched on for one chat only?

**Q:** Team mode: can the dsh team tools be enabled only in chats set to Team, when dsh mounts plugins for the whole process?

**A:** Not cleanly. `dsh-experimental-tool-agent-team` installs its nine tools per agent, but for every agent that `agentTeams.tryMembership` accepts, and every top-level session counts as a Lead. The tools are attached once, when the session's agent is created, and dsh has no hook to filter tools per request (`agent/request` swaps model settings only). Three of the team tools (`send_message`, `list_agents`, `interrupt_agent`) share names with dsh's subagent-control tools, so those have to be turned off process-wide either way. The `subagent` tool itself doesn't clash: the team profile disables it as a policy choice, but Auto's reviewer needs it.

Options: (1) mount the team tools for every chat and let Team mode prepend a `/team` instruction, relying on the built-in policy ("create teammates only when the user explicitly asks") to keep them dormant elsewhere; (2) a wrapper plugin that installs or removes them per session (fragile against an experimental package); (3) a second dsh process with the team profile for Team chats (clean, but a session must never be loaded in both processes). Recommendation: (1), keeping `subagent` (switched to one-shot) for Auto.

## 2026-10-08 — Can the main agent run subagents on a different model?

**Q:** Can the main agent use a different model for subagents?

**A:** Yes, for the `subagent` tool; not yet for team teammates. Today every subagent inherits the parent's model, because dsh-base leaves model selection off. dsh offers two switches on the `tool-subagent` row (built in `adapter/src/dsh/patch.ts`):
- **Fixed:** `agentOptions: { provider, model }` sends every subagent to one configured model (e.g. a cheap, fast one for Auto's reviewer).
- **Agent's choice:** mount `@deepseek-ai/dsh-tool-subagent/model-selection-settings` with `enabled: true` and an `allowedModels` list, and set `modelSelectionSettings: true` on the tool. The `subagent` tool then gains `provider` / `model` / `reasoning_effort` fields plus a `list_subagent_models` tool, limited to the allowed routes. The policy is recorded when a session is created, so only new chats get it. Our in-process `spawn` backend supports this.

Limits: `subagent_fork` always keeps the parent's model (so the copied history stays cacheable), and `spawn_teammate` has no model field, so teammates inherit the Lead's model.

## 2026-10-09 — Using a Claude Max plan with the dsh-based labweaver

**Q:** In the old labweaver (built on the Claude Code SDK) we used the Max plan. Can the current dsh-based version add Anthropic models and still bill them to a Max plan?

**A:** Anthropic models: yes. Max plan through dsh: no.

- **Why the old version worked:** the Agent SDK spawned the official `claude` CLI inside each container. `claude /login` stored OAuth tokens in `~/.claude.json`, so turns ran *as Claude Code* and were billed to the subscription.
- **Why dsh can't do the same:** subscription OAuth is only for Anthropic's own clients. The Agent SDK docs say: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…" (code.claude.com/docs/en/agent-sdk). Press reports say Anthropic has rejected subscription tokens from third-party clients since early 2026. Feeding a Max token to dsh breaks the terms and will likely be refused.
- **Path A (recommended): API key through dsh.** dsh's pi-ai adapter ships an `anthropic` route (`apiKeyEnv: ANTHROPIC_API_KEY`, `anthropic-messages` protocol). Adding it means one provider entry in `adapter/src/providers/registry.ts` plus a route in `adapter/src/dsh/patch.ts`. Billing is per token on the API.
- **Path B: a Claude Code engine.** The `AgentEngine` seam (`adapter/src/engine/types.ts`) could host a second engine built on the Agent SDK. That brings back subscription login, but only for your own personal use of your own Max plan. Sharing one Max plan across lab users is not allowed; each user would need their own key or plan. It's also a large job: hooks, MCP, skills and the transcript format all have to run on both engines.
