# Glossary

Domain terms for labweaver. Architecture reviews and code use these names.

**Chat**: a row in `chats` (name, mode, project dir, parent, engine session ID). Created, renamed and deleted through `ChatsRepo`.

**Chat mode**: `chat`, `auto` or `team`, stored per chat. Non-chat modes route a typed message through their slash command (`/tick`, `/team`).

**Auto mode**: the self-driving tick harness. One-shot: it covers one request, and the chat drops back to `chat` mode as that request's turn starts.

**Chat turn**: one user message sent to a chat, run on the agent engine until it ends or is stopped. Owns per-chat exclusion, stop, first-turn context, mode routing, the Auto marker, engine-session capture and post-turn project binding. Chat CRUD is not part of it.

**Session**: the agent engine's (dsh) session for a chat, identified by its session UUID; a chat resumes it on later turns.

**Workspace path**: a path the UI sends, relative to `/workspace`, resolved for `read` or `write` access by `workspace-path.ts`. It is never absolute and never contains `..`. Secrets (`.env*`, `.ssh`, `.git`, …) are refused at any depth for both access kinds. Writes are also refused to top-level harness files (`.labweaver` except `.labweaver/skills/`, `CLAUDE.md`, `.mcp.json`) and to the root itself. This guards against bugs rather than the UI's user: chat can already ask the agent to do anything in the container.

**Labweaver folder**: a user's `.labweaver/`, holding skills, commands, agents, hooks, `settings.json`, Auto markers (`auto/`) and session transcripts (`projects/`). It also contains the org-wide `shared.md`, as a read-only mount. On the host it is `hub/workspaces/<user>/.labweaver/`. In the container it is mounted at `/workspace/.labweaver`, and `~/.labweaver` links to it. Org skills are separate, in `/workspace/shared/skills`. Code names the folder through `LABWEAVER_DIR` (`adapter/src/labweaver-dir.ts`). It was called `.claude/` before the engine moved to DSH.
