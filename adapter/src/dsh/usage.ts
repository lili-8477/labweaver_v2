// Reads the per-call token usage that dsh-plugins/usage.js records, since
// dsh sends none over ACP. One JSON line per top-level model call, in dsh's
// TokenUsage shape.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { TurnTokens } from "../engine/types.js";

/** Sum and remove the usage recorded for a session; null when nothing was recorded. */
export async function takeTurnUsage(dir: string, sessionId: string): Promise<TurnTokens | null> {
  const file = path.join(dir, `${sessionId}.jsonl`);
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  await fs.rm(file, { force: true });
  const total: TurnTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let calls = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const u = JSON.parse(line) as Record<string, unknown>;
      total.input += num(u.inputTokens);
      total.output += num(u.outputTokens);
      total.cacheRead += num(u.cacheReadTokens);
      total.cacheWrite += num(u.cacheWriteTokens);
      calls++;
    } catch { /* torn line from a crash: skip */ }
  }
  return calls > 0 ? total : null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
