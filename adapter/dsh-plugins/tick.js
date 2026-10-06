// DeepSeek Harness plugin "tick": drives auto mode (the self-driving tick
// harness). dsh loads this file itself, so it is plain ESM, not TypeScript.
// Mounted by the adapter's cordis patch: see src/dsh/patch.ts.
//
// The adapter starts an auto-mode turn as `/tick <message>`. When that turn is
// about to stop, this plugin steers it into the next orchestrator round with
// the full tick.md text (dsh never expands `/tick` itself), until the project's
// progress.md reaches `## Status: complete`, the user pauses or turns auto mode
// off, or MAX_ROUNDS is hit. Replaces the Claude Code Stop hook stop_tick.sh,
// which had no loop cap and no way to tell subagents from the main agent.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "tick";

const CLAUDE_DIR = join(homedir(), ".claude");
const MARKER = join(CLAUDE_DIR, ".harness_active");
const PAUSE = join(CLAUDE_DIR, ".tick_paused");
const PROJECT = join(CLAUDE_DIR, ".harness_dir");
const ORCHESTRATOR = join(CLAUDE_DIR, "commands", "tick.md");
const MAX_ROUNDS = 40;
const CONTINUE = "(No new message: this is the next tick of the same task.)";

function read(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function complete() {
  const dir = read(PROJECT)?.trim();
  return !!dir && /^## Status: complete/m.test(read(join(dir, "progress.md")) ?? "");
}

export function apply(ctx) {
  const rounds = new WeakMap();

  ctx.on("agent/turn-stopping", ({ agent }) => {
    const done = agent.session.header.delegationDepth  // subagents never tick
      || !existsSync(MARKER) || existsSync(PAUSE) || complete();
    const n = rounds.get(agent) ?? 0;
    const body = done ? null : read(ORCHESTRATOR);
    if (!body || n >= MAX_ROUNDS) {
      if (n >= MAX_ROUNDS) ctx.logger.warn(`tick: stopped after ${MAX_ROUNDS} rounds`);
      rounds.delete(agent);
      return;
    }
    rounds.set(agent, n + 1);
    const text = body.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/\$ARGUMENTS/g, CONTINUE).trim();
    agent.steer(createUserMessage({ content: [{ type: "text", text }], source: { kind: name } }));
  });
}
