// DeepSeek Harness plugin "usage". dsh loads this file itself, so it is plain
// ESM, not TypeScript. Mounted by the adapter's cordis patch: see
// src/dsh/patch.ts.
//
// dsh keeps each model call's token usage on its session events but sends
// none of it over ACP. This appends one JSON line per top-level assistant
// message to $DSH_HOME/usage/<session id>.jsonl; the adapter sums and removes
// the file when the turn ends (src/dsh/usage.ts). Subagent calls run in child
// sessions and are not counted.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "usage";

const DIR = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "usage");

export function apply(ctx) {
  mkdirSync(DIR, { recursive: true });
  ctx.on("session/event", (session, event) => {
    const usage = event.type === "assistant/message" ? event.data.usage : undefined;
    if (!usage || session.header.delegationDepth) return;
    appendFileSync(join(DIR, `${session.header.id}.jsonl`), JSON.stringify(usage) + "\n");
  });
}
