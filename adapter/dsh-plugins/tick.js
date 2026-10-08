// DeepSeek Harness plugin "tick": drives auto mode (the self-driving tick
// harness). dsh loads this file itself, so it is plain ESM, not TypeScript.
// Mounted by the adapter's cordis patch: see src/dsh/patch.ts.
//
// The adapter starts an auto-mode turn as `/tick <message>` and marks the
// session with ~/.claude/auto/<session id>, which holds the project directory
// (empty until tick-bootstrap writes it; see src/harness.ts). Each time that
// turn is about to stop, this plugin reads the project's progress.md, decides
// the next step in code (nextStep below — routing is a pure function of
// progress.md, so no model call is spent on it), and steers the agent with one
// short instruction: do the step itself, or, for the reviewer, dispatch it as a
// subagent so the review runs in a clean context. It stops when the project is complete, the user
// pauses or switches the chat out of auto mode, MAX_ROUNDS is hit, or the same step comes up
// MAX_REPEATS rounds in a row (the subagent is not advancing progress.md).

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "tick";

const CLAUDE_DIR = join(homedir(), ".claude");
const AUTO_DIR = join(CLAUDE_DIR, "auto");
const PAUSE = join(CLAUDE_DIR, ".tick_paused");
const MAX_ROUNDS = 40;
const MAX_REPEATS = 3;
// Steps that run as a subagent; the main agent does every other step itself.
const SUBAGENTS = new Set(["tick-reviewer"]);

function read(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** Lines of a `## <title>` section, or null when the section is absent. */
function section(md, title) {
  const m = md.match(new RegExp(`^## ${title}(?:[ \\t][^\\n]*)?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
  return m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean) : null;
}

/**
 * The tick priority: which subagent runs next and on what, given progress.md
 * (null when the project does not exist yet). Returns { agent, work }, or
 * { complete: true } when every step is reviewed and the retrospective is done.
 */
export function nextStep(md) {
  if (md == null) return { agent: "tick-bootstrap", work: "the user's task message that started this auto-mode run (quote it verbatim)" };
  if (/^## Status: complete/m.test(md)) return { complete: true };
  const plan = section(md, "Plan") ?? [];
  if (plan.length === 0) return { agent: "tick-planner", work: "instantiate the plan from the pipeline template" };
  const feedback = (section(md, "Review feedback") ?? []).find((l) => l.startsWith("☐"));
  if (feedback) return { agent: "tick-executor", work: feedback };
  const unreviewed = plan.find((l) => l.includes("☑") && !l.includes("(reviewed)"));
  if (unreviewed) return { agent: "tick-reviewer", work: unreviewed };
  const todo = plan.find((l) => l.includes("☐"));
  if (todo) return { agent: "tick-executor", work: todo };
  if (!/^## Retrospective: done/m.test(md)) return { agent: "tick-retrospective", work: "the finished project" };
  return { complete: true };
}

function instruction(round, file, dir, step) {
  const sub = SUBAGENTS.has(step.agent);
  return [
    `[auto mode · round ${round}] ${sub ? "Dispatch" : "Do"} \`${step.agent}\` now${sub ? "" : ", yourself"}.`,
    `Agent file: ${join(CLAUDE_DIR, "agents", `${step.agent}.md`)}`,
    `Project directory: ${dir ?? "none yet"}`,
    `Project file: ${file}`,
    `Work item: ${step.work}`,
    `Follow the ${sub ? "Dispatch" : "Do"} procedure in ${join(CLAUDE_DIR, "commands", "tick.md")}.`,
  ].join("\n");
}

export function apply(ctx) {
  const turns = new WeakMap(); // agent -> { rounds, last, repeats } for the turn in flight

  ctx.on("agent/turn-stopping", ({ agent }) => {
    const t = turns.get(agent) ?? { rounds: 0, last: "", repeats: 0 };
    const file = join(AUTO_DIR, agent.id);
    const active = !agent.session.header.delegationDepth  // subagents never tick
      && existsSync(file) && !existsSync(PAUSE);
    const dir = active ? read(file)?.trim() || null : null;
    const progress = dir ? join(dir, "progress.md") : null;
    const step = active ? nextStep(progress ? read(progress) : null) : null;
    const key = step && !step.complete ? `${step.agent}\n${step.work}` : "";
    const repeats = key === t.last ? t.repeats + 1 : 1;
    const stuck = repeats > MAX_REPEATS || t.rounds >= MAX_ROUNDS;
    if (!step || step.complete || stuck) {
      if (step?.complete && !/^## Status: complete/m.test(read(progress) ?? "")) {
        appendFileSync(progress, "\n## Status: complete\n");
      }
      if (stuck) ctx.logger.warn(`tick: stopped after ${t.rounds} rounds (${repeats > MAX_REPEATS ? "no progress" : "round limit"})`);
      turns.delete(agent);
      return;
    }
    turns.set(agent, { rounds: t.rounds + 1, last: key, repeats });
    agent.steer(createUserMessage({ content: [{ type: "text", text: instruction(t.rounds + 1, file, dir, step) }], source: { kind: name } }));
  });
}
