# DeepSeek Harness migration (replace Claude Agent SDK, add Ollama Cloud)

**Goal:** the adapter drives agent turns through DeepSeek Harness (`dsh`)
instead of `@anthropic-ai/claude-agent-sdk`. Ollama Cloud becomes a selectable
model provider next to DeepSeek. Skills, memory and NATS keep working, and the
frontend wire contract stays the same.

## 1. Current architecture

```
frontend ──NATS──▶ adapter/index.ts ─▶ NatsBus ─▶ RpcRouter.dispatch
                                                     │ chat / stop_chat
                                                     ▼
                                   claude.ts runTurn (the only SDK import)
                                                     │ SDKMessage
                                                     ▼
                                  events.ts EventTranslator ─▶ StreamEvent ─▶ NATS
Claude CLI ─writes─▶ ~/.claude/projects/<enc-cwd>/<uuid>.jsonl
                         ├─▶ history.ts           (get_chat_messages)
                         └─▶ hub/indexer watcher  (sessions, tokens, /memory distill)
```

Where the code depends on Claude Code:

| Concern | Current mechanism | Where |
|---|---|---|
| Model execution | `query()` + `resume` + `bypassPermissions` | `adapter/src/claude.ts` |
| Model choice | `model` in `~/.claude/settings.json`, read by the CLI | `rpc.ts` get/set_model |
| Skills | CLI discovers `~/.claude/skills` and `/workspace/.claude/skills` | entrypoint stitches symlinks |
| Commands | CLI expands `~/.claude/commands/*.md` | `/memory`, `/recall`, … |
| Instructions | CLI reads `CLAUDE.md` (`@import` of the shared file) | add-user.sh |
| Hooks | CLI runs settings.json hooks | hub/skeleton/harness/hooks |
| MCP | CLI reads `/workspace/.mcp.json` | labweaver-memory MCP |
| Memory / history | CLI writes the Claude JSONL transcript | indexer, history.ts |

## 2. Target design

Drive `dsh --profile acp` over the Agent Client Protocol
(`@agentclientprotocol/sdk`). One long-lived child process serves every chat.
ACP is the only DSH transport that supports cancel (`stop_chat`), resume after
a restart, a cwd per session, and many concurrent sessions. The DSH SDK
transport has none of these.

```
RpcRouter ─▶ AgentEngine (engine/types.ts)        ◀── harness-neutral seam
               └─ DshAcpEngine (dsh/engine.ts)
                    ├─ DshAcpConnection (dsh/acp-connection.ts)  spawn + ACP client
                    ├─ mapSessionUpdate (dsh/acp-mapper.ts)      pure ACP → AgentEvent
                    └─ prompt blocks / MCP servers (dsh/prompt.ts, mcp-config.ts)
turn-runner.ts: AgentEvent ─┬─▶ EventTranslator ─▶ StreamEvent ─▶ NATS (unchanged)
                            └─▶ ClaudeTranscriptWriter ─▶ ~/.claude/projects/…jsonl
providers/registry.ts: DeepSeek + Ollama Cloud specs, "provider/model" refs
dsh/patch.ts: providers + skills + hooks ─▶ cordis patch (--patch)
slash-commands.ts: expands ~/.claude/commands/<name>.md before the prompt
```

How each existing feature survives the switch (each item was verified in a
spike against `@deepseek-ai/dsh@0.2.0-rc.2`):

- **Memory and history.** The adapter writes a Claude-format JSONL transcript
  from the event stream. ACP session ids are UUIDs, which the indexer
  requires. `history.ts`, the indexer and `/memory` distill need no changes.
- **Skills.** The `skill-filesystem` `customSkillDirs` setting is pointed at
  `~/.claude/skills` and `/workspace/.claude/skills`. DSH's `/name` skill
  invocation and `skill` tool replace the Claude `Skill` tool.
- **Instructions.** DSH `agent-instructions` reads `CLAUDE.md` natively. It
  does not support `@import`, so the entrypoint links `$DSH_HOME/AGENTS.md` to
  the shared file.
- **Hooks.** The `dsh-hooks-claude-code` plugin is mounted with
  `~/.claude/settings.json`. Hooks that only printed context to stdout now
  emit the JSON `additionalContext` form, which works in both runtimes.
- **MCP.** `.mcp.json` is passed to ACP `session/new` / `session/resume` as
  `mcpServers`, with commands resolved to absolute paths.
- **Permissions.** `DSH_PERMISSION_MODE=danger-full-access` is the equivalent
  of `bypassPermissions`. As a fallback, the client auto-approves any
  permission request.

**Providers.** `deepseek-official` is built into DSH and uses
`DEEPSEEK_API_KEY`. `ollama-cloud` is a hand-declared llm-pi-ai route:
`openai-completions` at `https://ollama.com/v1` with `OLLAMA_API_KEY`, and its
model list can be overridden with `OLLAMA_CLOUD_MODELS`. Models are referenced
as `provider/model` and switched per session with `session/set_config_option`.

**Known gaps** (documented here; not addressed in this refactor):

- No live token streaming. Text arrives once per committed step.
- No dollar cost; tokens show the context occupancy only.
- The tick self-driving harness depends on Claude's `Task`/`SlashCommand` tools
  and markdown subagents, which DSH does not load.

## 3. Modules (each lands with its own unit tests)

1. `engine/types.ts`: `AgentEngine`, `AgentEvent`, `RunTurnArgs`.
2. `providers/registry.ts`: provider specs, model-ref parse/format, list.
3. `dsh/patch.ts`: pure builder for the cordis patch (JSON, which is valid YAML).
4. `dsh/acp-mapper.ts`: pure ACP `SessionUpdate` → `AgentEvent[]`.
5. `transcript/claude-jsonl.ts`: Claude-format transcript writer, verified
   by round-tripping through `history.ts`.
6. `slash-commands.ts` and `mcp-config.ts`: pure expanders/readers.
7. `dsh/acp-connection.ts` and `dsh/engine.ts`: integration-tested against a
   real `dsh` child process and a fake OpenAI-compatible server.
8. `turn-runner.ts`, and rewiring `rpc.ts`/`index.ts`: `list_models`;
   `get_model`/`set_model` switch to provider refs.
9. Remove `claude.ts` and the Claude SDK dependencies.
10. Packaging: Node 22 image (dsh needs ≥22.19), `DSH_HOME` persisted per
    user, keys in `.env`, hook JSON output, frontend `ModelSelect` driven by
    `list_models`, README.
