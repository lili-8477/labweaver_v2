// DeepSeek Harness plugin "next-step". dsh loads this file itself (it runs in
// the dsh child process, not the adapter), so it is plain ESM, not TypeScript.
// Mounted by the adapter's cordis patch: see src/dsh/patch.ts.
//
// Registers `suggest_next_steps`: at the end of a task the model calls it with
// a few short follow-ups. The call reaches the frontend as an ordinary tool
// call, where useChatHints turns its `options` into chips above the chat box.
// Smaller models skip optional end-of-turn tools, so a top-level turn that used
// tools without suggesting gets one steer before it stops (one extra step).
// Auto mode (tick.js) owns turn endings while it is on, so the nudge stands down.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "next-step";
export const inject = ["tools", "systemPrompt"];

const TOOL = "suggest_next_steps";
const MAX_OPTIONS = 4;
const AUTO_MODE_MARKER = join(homedir(), ".claude", ".harness_active");

const NUDGE = `Before you stop: call ${TOOL} with the user's likely next steps. Do not restate your answer.`;
const GUIDANCE = `When you finish a task for the user, call ${TOOL} once with 2-${MAX_OPTIONS} short, concrete follow-ups the user is likely to want next: imperative, under 10 words each, specific to this work. Skip it for small talk, or when you are asking the user a question. Do not repeat the suggestions in your reply.`;

export function apply(ctx) {
  // Per-agent state for the turn in flight; cleared when the turn really stops.
  const turns = new WeakMap();

  ctx.on("tools/post-execute", (exec, _result, next) => {
    if (exec.agent) {
      const t = turns.get(exec.agent) ?? { usedTools: false, suggested: false, nudged: false };
      t.usedTools = true;
      if (exec.name === TOOL) t.suggested = true;
      turns.set(exec.agent, t);
    }
    return next();
  });

  ctx.on("agent/turn-stopping", ({ agent }) => {
    const t = turns.get(agent);
    const topLevel = !agent.session.header.delegationDepth;
    if (topLevel && t?.usedTools && !t.suggested && !t.nudged && !existsSync(AUTO_MODE_MARKER)) {
      t.nudged = true;
      agent.steer(createUserMessage({ content: [{ type: "text", text: NUDGE }], source: { kind: name } }));
      return;
    }
    turns.delete(agent);
  });

  ctx.systemPrompt.section({
    name: "next-step",
    order: ctx.systemPrompt.getSectionOrder("TOOL_WORKFLOW"),
    text: GUIDANCE,
  });

  ctx.tools.register(defineTool({
    name: TOOL,
    description: `Offer the user ${MAX_OPTIONS} or fewer clickable next steps after finishing a task. They are shown as options under the chat box; the user picks one or ignores them.`,
    parameters: {
      options: {
        type: "array",
        required: true,
        description: `2-${MAX_OPTIONS} next steps, each an imperative line under 10 words.`,
        items: { type: "string" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { shown: { type: "integer", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: `Shown ${value.shown} next-step option(s) to the user. End your turn now; write nothing more.` }],
    },
    execute(args) {
      const shown = args.options.map((o) => o.trim()).filter(Boolean).slice(0, MAX_OPTIONS).length;
      if (shown === 0) throw new Error("options must contain at least one non-empty step");
      return Promise.resolve({ shown });
    },
  }));
}
