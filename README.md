

# LabWeaver

A shared, self-improving laboratory AI that turns a single-user coding agent
into persistent research infrastructure.

## Mission

Agentic AI promises to democratize data analysis across research laboratories,
yet its current prompt-by-prompt use suffers from three compounding
limitations: **loss of institutional knowledge**, **fragmented research
environments**, and **non-reproducible AI workflows**. Experimental protocols,
decision rationales, and laboratory context are rarely preserved, leading to
inconsistent documentation, difficult onboarding, and analyses that cannot be
reliably regenerated across users or time.

LabWeaver transforms a single-user coding agent into persistent research
infrastructure. It continuously accumulates laboratory knowledge from daily
use as reusable **skills** and structured **memory**, enabling context-aware
reasoning grounded in a lab's protocols, inventories, and prior discoveries.
Through shared agent rules, a common filesystem contract, and an automated
multi-agent reasoning framework, LabWeaver executes autonomous, long-running
scientific workflows while maintaining reproducibility and continuity across
researchers.

## Case study — synovial sarcoma scRNA-seq

We demonstrate LabWeaver on a synovial sarcoma mouse-model single-cell
RNA-seq analysis. A native AI generated only a generic single-cell workflow
and cell annotations based on marker genes. LabWeaver leveraged accumulated
laboratory knowledge — including H&E morphology and marker-gene
interpretation — to identify **SS18-SSX2 fusion-oncogene expression** and
assign lab-specific cell states, including **biphasic** and **monophasic**
synovial sarcoma cells. These insights were not obtained by the native AI
alone.

LabWeaver reframes agentic analysis from a transient query interface into a
persistent laboratory infrastructure that captures, organizes, and compounds
scientific knowledge — a feedback loop in which accumulated experience
continuously improves future AI-driven discovery.

Demo walk-through: 


https://github.com/user-attachments/assets/d6bd8825-ba3b-46ab-a8df-a00b71a5925d


.

## Architecture

- **Frontend** — Vue 3 + Pinia + nats.ws over a NATS WebSocket contract.
- **Adapter** — small TypeScript bridge inside each user's container. It
  drives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
  (`dsh --profile acp`, over the Agent Client Protocol) behind a
  harness-neutral `AgentEngine` seam, and translates its events into the
  frontend's `chunk` / `step_message` / `chat_finished` stream.
- **Model providers** — DeepSeek (`DEEPSEEK_API_KEY`) and Ollama Cloud
  (`OLLAMA_API_KEY`, OpenAI-compatible `https://ollama.com/v1`), selected
  per chat turn as `provider/model` from the UI.
- **Image** — Node 22 + the adapter (which bundles `dsh`) on top of the bio
  stack (Python 3.12, scanpy, R 4.5.3, Seurat / SoupX / scDblFinder).
- **Hub** — docker-compose with NATS + nginx + per-user container
  provisioning.
- **Skills** — a user's skills bind-mount into the container at
  `~/.claude/skills/` and are registered with the harness as skill roots;
  org-wide skills live under `hub/workspaces/shared/skills/` and mount
  read-only.
- **Memory** — structured laboratory memory persists across sessions and
  feeds back into every turn. The adapter writes each turn as a
  Claude-format JSONL transcript, which the hub indexer distills.

See `docs/superpowers/plans/2026-10-02-deepseek-harness-migration.md` for
the harness design and its known gaps.

## Layout

```
labweaver/
├── frontend/                 # Vue 3 + Pinia + nats.ws
├── adapter/                  # TypeScript NATS <-> DeepSeek Harness bridge
├── image/                    # Dockerfile for the per-user devcontainer
├── hub/                      # docker-compose + nginx + provisioning scripts
├── .devcontainer/            # VS Code "Reopen in Container"
├── docker-compose.dev.yml    # single-user local dev (no nginx)
└── README.md                 # this file
```

See `image/README.md` for Dockerfile details.

> Internal image tags, container names, and the NPM frontend package still
> use the legacy `labweaver` / `labweaver` prefix. Those are operational
> identifiers, not the product name — leave them alone unless you also
> migrate the running stack.

## Quick start (multi-user hub)

Prerequisites: Docker, Node 20, `htpasswd` (or Docker can stand in).

```bash
# 1. Build the adapter bundle.
cd adapter
npm ci
npm test          # contract tests against the frontend event shape
npm run build
cd ..

# 2. Build the frontend static bundle (nginx serves this).
cd frontend
npm ci
npm run build
cd ..

# 3. Build the devcontainer image. Base is pantheon-agents-sc:latest — if
#    you don't have it, build it from ../pantheon-hub/images/sc-runtime/
#    or switch FROM to a fresh Debian + Node + Python + R stack.
#    No base image? Layer this adapter onto an existing per-user image
#    instead: see image/Dockerfile.overlay.
docker build -f image/Dockerfile -t labweaver:dev .

# 4. Start shared infra (NATS + nginx).
cd hub
docker compose up -d
docker compose ps

# 5. Add your first user (DeepSeek key positional; Ollama Cloud key via env).
OLLAMA_API_KEY=xxxx ./scripts/add-user.sh alice sk-xxxxxxxx
```

The final command prints the user's `service_id`: a random 64-hex secret,
recorded in `hub/users.md` (gitignored, mode 600). It is the user's access
key — share it only with that user. `recreate-user.sh` reuses it and
`remove-user.sh` retires it; `hub/scripts/service-id.sh get <user>` looks it
up. Open
`http://localhost:8088/` (or whatever nginx binds), enter
`ws://localhost:8088/ws/` as the WebSocket URL, the printed service ID, and
the username/password you chose.

## Quick start (single-user local dev)

```bash
docker build -f image/Dockerfile -t labweaver:dev .

# Create a minimal devuser workspace.
mkdir -p hub/workspaces/devuser/.claude/{skills,agents,chats,claude-projects}
mkdir -p hub/workspaces/devuser/{projects,.dsh}
echo '{"model":"deepseek-official/deepseek-v4-pro"}' > hub/workspaces/devuser/.claude/settings.json
printf 'DEEPSEEK_API_KEY=sk-...\nOLLAMA_API_KEY=...\n' > hub/workspaces/devuser/.env
# Random service ID, recorded in hub/users.md and handed to the adapter.
echo "SERVICE_ID=$(hub/scripts/service-id.sh ensure devuser)" >> hub/workspaces/devuser/.env

docker compose --env-file hub/.env -f docker-compose.dev.yml up -d
```

Running beside another hub on the same host? Put port/image overrides in an
untracked `docker-compose.dev.local.yml` and add `-f docker-compose.dev.local.yml`.

Point the frontend at `ws://localhost:8081/` (direct NATS WebSocket, no nginx
prefix) with the service ID from `hub/scripts/service-id.sh get devuser`.

## How to drop in a skill

Skills are plain markdown. The adapter registers `~/.claude/skills/` with
DeepSeek Harness, which watches it, so new skills appear without a restart.

```bash
mkdir -p hub/workspaces/alice/.claude/skills/scrna-qc
cat > hub/workspaces/alice/.claude/skills/scrna-qc/SKILL.md <<'SKILL'
---
name: scrna-qc
description: Run standard scanpy QC on an AnnData object
---
...
SKILL
```

That's it. No restart needed — next turn, the skill is live inside the
container at `/home/node/.claude/skills/scrna-qc/SKILL.md`.

Org-wide skills live at `hub/workspaces/shared/skills/` and are mounted
read-only at `/home/node/.claude/skills-shared/` in every user's container.

## How to open a project

Each user's `projects/<project-name>/` doubles as a Claude Code working
directory. Drop a `CLAUDE.md` in it for project-specific notes Claude Code
loads automatically, and optionally `.claude/settings.json` for
project-scoped tool/model settings.

```
hub/workspaces/alice/projects/
├── pbmc3k-qc/
│   ├── CLAUDE.md           # project brief, data layout notes
│   ├── .claude/
│   │   └── settings.json   # override model or add skills just for this project
│   ├── data/
│   └── results/
└── hca-atlas/
```

## How to resume a chat

`chat_id` is a UUID, used directly as the Claude Code session ID. Session
history persists at `~/.claude/projects/-workspace/<chat_id>.jsonl` inside
the container. Reloading the frontend and selecting the chat calls
`get_chat_messages` which reads the JSONL and re-renders the timeline.

`stop_chat` aborts cleanly via the SDK's AbortController so the JSONL stays
well-formed; the next `chat` call resumes the same session.

## Parity check (GO/NO-GO)

Before switching production users over (or adopting this for daily work),
drive the frontend against a test user and verify each scenario:

1. `create_chat` — new chat appears in sidebar; `chat_id` is a UUID.
2. `chat` RPC (frontend send) — streams text, rendered live in ChatPanel.
3. Tool calls render in ExecutionTimeline with name, JSON-parsed args, duration, cumulative tokens and cost.
4. Subagent delegation shows the `→` `transfer` badge.
5. `chat_finished` flips the running indicator off; no orphan `claude` child (`pgrep -af claude` inside the container).
6. Reload the page → `list_chats` + `get_chat_messages` reconstruct the timeline from session JSONL + sidecar.
7. `delete_chat` removes JSONL + sidecar.
8. `stop_chat` during streaming aborts cleanly; next `chat` resumes the same session.
9. Drop a `SKILL.md` into `hub/workspaces/<user>/.claude/skills/<name>/` → it appears at `/home/node/.claude/skills/` inside the container → invoking by name works.
10. `file_manager.list_files` (via `proxy_toolset`) returns the `/workspace/` tree.

Then soak: 48h under representative load. Watch `pgrep -af claude` (stable),
session JSONL tails (not truncated), nats-server logs (no `slow consumer`).

## Contract

The frontend's NATS RPCs and stream event shapes are the source of truth —
if the SDK changes, fix the adapter translator, not the frontend. See
`adapter/test/events.test.ts` (vitest contract tests).

## Adapter test suite

```bash
cd adapter
npm test
npm run typecheck
```

Tests cover:
- Event translation (SDK messages → `chunk` / `step_message` / `chat_finished`)
- `tool_calls[].function.arguments` is a JSON **string**, not an object (the frontend JSON.parses it)
- Tool-call duration is measured in the adapter (SDK doesn't expose it)
- Per-chat mutex rejects overlapping `chat` RPCs
- `AbortController` cleanly aborts in-flight turns
- Session sidecar CRUD and path-escape guards in `file_manager`
- `commands_list`, `skills_list`, and `org_skills_list` enumerate
  `~/.claude/commands/` and the two skill tiers for the in-app slash menu.

## License

MIT. Frontend originally ported from pantheon-frontend (also MIT).
