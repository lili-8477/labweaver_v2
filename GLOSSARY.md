# Glossary

Domain terms for labweaver. Architecture reviews and code use these names.

**Chat**: a row in `chats` (name, mode, project dir, parent, engine session ID). Created, renamed and deleted through `ChatsRepo`.

**Chat mode**: `chat`, `auto` or `team`, stored per chat. Non-chat modes route a typed message through their slash command (`/tick`, `/team`).

**Auto mode**: the self-driving tick harness. One-shot: it covers one request, and the chat drops back to `chat` mode as that request's turn starts.

**Chat turn**: one user message sent to a chat, run on the agent engine until it ends or is stopped. Owns per-chat exclusion, stop, first-turn context, mode routing, the Auto marker, engine-session capture and post-turn project binding. Chat CRUD is not part of it.

**Session**: the agent engine's (dsh) session for a chat, identified by its session UUID; a chat resumes it on later turns.

**Workspace path**: a path the UI sends, relative to `/workspace`, resolved for `read` or `write` access by `workspace-path.ts`. It is never absolute and never contains `..`. Secrets (`.env*`, `.ssh`, `.git`, …) are refused at any depth for both access kinds. Writes are also refused to top-level harness files (`.labweaver` except `.labweaver/skills/`, `CLAUDE.md`, `.mcp.json`) and to the root itself. This guards against bugs rather than the UI's user: chat can already ask the agent to do anything in the container.

**Labweaver folder**: a user's `.labweaver/`, holding skills, commands, agents, hooks, `settings.json`, Auto markers (`auto/`) and session transcripts (`projects/`). It also contains the org-wide `shared.md`, as a read-only mount. On the host it is `hub/workspaces/<user>/.labweaver/`. In the container it is mounted at `/workspace/.labweaver`, and `~/.labweaver` links to it. Org skills are separate, in `/workspace/shared/skills`. Code names the folder through `LABWEAVER_DIR` (`adapter/src/labweaver-dir.ts`). It was called `.claude/` before the engine moved to DSH.

**Chat item**: one thing the chat view shows, in the order the agent produced it. A `user` item is a message the user sent, a `text` item is the agent's prose (consecutive text joined), and a `tool` item is a call with its result (name, input, output, error flag, start/end time). Items are a projection of the session transcript (`chat-items.ts`). A live turn projects each entry as it is written and streams the items it changed. `get_chat_items` projects the stored transcript. Both use the same ids and times, so a finished turn looks the same as it did while it ran.

**Memory contract**: the table of memory-api operations in `hub/indexer/src/memory-contract.ts`. For each operation it gives the HTTP route, the identity field (`username` or `actor`), the caller's input schema (zod) and the result type. The API validates with these schemas, and the repo returns these types. The adapter forwards the UI's `memory_*` RPCs through it, filling in the identity with its own user. mcp-memory derives its tool schemas from it, and the frontend imports its types. A new operation is one contract entry plus one route handler.

**Memory access**: who may see and who may change a memory, decided in `hub/indexer/src/memory-access.ts`. A memory is visible to a viewer when it is theirs or the org's and its access class (`public` < `internal` < `restricted` < `irb`) is within the viewer's clearance (`MEMORY_CLEARANCE`, default `internal`). Only the owner sees their deleted rows. Every read path applies this rule: search, get by id, timeline, list, tree, directories, the bundle and its lineage links. Deleted, superseded and project filters are each query's own choice, not visibility. Only the owner changes a memory (`withOwnedRow`: row lock, owner check, one transaction).

**User container**: one user's devcontainer, `labweaver-<user>`, provisioned by `hub/scripts/lib/user-container.sh` for both `add-user.sh` and `recreate-user.sh`. The workspace preparation (dirs, harness skeleton, hook entries, memory MCP registration) and the `docker run` are the same code for both, so a recreate gives the same container an add did. The dev stack's `devuser` is a compose service instead, not a user container.

**Container spec**: what a user container is built from, beyond the workspace: the image, the hub hosts (network, NATS, Postgres, indexer, nginx) and the data mounts. Saved by `add-user.sh` at `hub/workspaces/<user>/container.env`, outside every bind mount. `recreate-user.sh` reads it; `IMAGE=` on a recreate replaces the image and is saved.

**Memory domain**: whether a memory is `lab` knowledge (samples, experiments, protocols, analysis choices, results, lab decisions) or `technical` know-how (code, packages, environment, tool errors). The writer sets it: `memory_write` requires it, and distill requires it on each experience (claims and the run default to `lab`). `hub/indexer/src/memory-domain.ts` holds the guidance the agent follows (`DOMAIN_HELP`). The chat UI is for life scientists, so the adapter pins its listings (search, list, directories, tree) to `lab` (`UI_DOMAIN`). The agent reads both. A wrong label is fixed with `memory_update`/`memory_merge` and `domain`.

**Progress file**: an Auto-mode project's `progress.md`, which holds the plan (`## Plan`, one `☐`/`☑` line per step, `(reviewed)` once checked), open review notes (`## Review feedback`, `☐` lines), and the completion markers. It is read only through `adapter/dsh-plugins/progress.js`. `nextStep` is the tick router's choice of what runs next: open review notes first, then the oldest unreviewed step, then the next unchecked step, then the retrospective. `parseProgress` is the UI's view of the same file, and its next step is `nextStep`'s answer.
