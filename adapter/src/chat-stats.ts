// Token totals and subagent runs for one chat, read from the Claude-format
// transcripts (get_chat_stats RPC, the Agents panel).
//
// The chat's own transcript carries one message.usage per turn (see
// transcript/claude-jsonl.ts). Subagent runs are the sidechain transcripts
// dsh-plugins/sidechain.js writes beside it, linked by parentSessionId; the
// parent's `subagent` tool calls give each run its description and outcome.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CONTINUATION_TYPE, transcriptPath } from "./history.js";

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SubagentRun {
  sessionId: string;
  description: string | null;
  /** "stopped": no result and the chat's turn is no longer running. */
  status: "running" | "done" | "failed" | "stopped";
  model: string | null;
  startedAt: string;
  endedAt: string;
  tokens: TokenTotals;
  toolCalls: number;
  /** First line of the run's last reply. */
  result: string | null;
}

export interface ChatStats {
  /** The chat's own turns, every session in its continuation chain. */
  main: TokenTotals;
  turns: number;
  lastTurn: TokenTotals | null;
  subagents: SubagentRun[];
}

type Entry = Record<string, any>;

const MAX_CONTINUATION_DEPTH = 8;

const zero = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function usageOf(entry: Entry): TokenTotals | null {
  const u = entry.type === "assistant" ? entry.message?.usage : undefined;
  if (!u) return null;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

function add(into: TokenTotals, u: TokenTotals): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
}

function parseLines(raw: string): Entry[] {
  const out: Entry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn last line */ }
  }
  return out;
}

const blocks = (entry: Entry): Entry[] =>
  Array.isArray(entry.message?.content) ? entry.message.content : [];

interface SubagentCall { id: string; at: string; description: string | null }
interface CallResult { at: string; isError: boolean }

export async function readChatStats(
  home: string,
  cwd: string,
  sessionId: string,
  running: boolean,
): Promise<ChatStats> {
  const dir = path.dirname(transcriptPath(home, cwd, sessionId));
  const main = zero();
  let turns = 0;
  let lastTurn: TokenTotals | null = null;
  const sessions = new Set<string>();
  const calls: SubagentCall[] = [];
  const results = new Map<string, CallResult>();

  // Oldest session first, so lastTurn ends on the newest.
  const readSession = async (id: string, depth: number): Promise<void> => {
    sessions.add(id);
    const raw = await fs.readFile(transcriptPath(home, cwd, id), "utf8").catch(() => "");
    for (const e of parseLines(raw)) {
      if (e.type === CONTINUATION_TYPE && typeof e.previousSessionId === "string") {
        if (depth < MAX_CONTINUATION_DEPTH) await readSession(e.previousSessionId, depth + 1);
        continue;
      }
      const u = usageOf(e);
      if (u) { add(main, u); turns++; lastTurn = u; }
      for (const b of blocks(e)) {
        if (b.type === "tool_use" && b.name === "subagent") {
          calls.push({ id: b.id, at: e.timestamp, description: b.input?.description ?? null });
        } else if (b.type === "tool_result") {
          results.set(b.tool_use_id, { at: e.timestamp, isError: b.is_error === true });
        }
      }
    }
  };
  await readSession(sessionId, 0);

  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const subagents: SubagentRun[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl") || sessions.has(name.slice(0, -6))) continue;
    const raw = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
    const first = parseLines(raw.slice(0, raw.indexOf("\n") + 1 || undefined))[0];
    if (!first?.isSidechain || !sessions.has(first.parentSessionId)) continue;
    subagents.push(summarizeRun(parseLines(raw), calls, results, running));
  }
  subagents.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  return { main, turns, lastTurn, subagents };
}

function summarizeRun(
  entries: Entry[],
  calls: SubagentCall[],
  results: Map<string, CallResult>,
  running: boolean,
): SubagentRun {
  const tokens = zero();
  let toolCalls = 0;
  let model: string | null = null;
  let result: string | null = null;
  for (const e of entries) {
    const u = usageOf(e);
    if (u) add(tokens, u);
    model ??= e.message?.model ?? null;
    for (const b of blocks(e)) {
      if (b.type === "tool_use") toolCalls++;
      if (b.type === "text" && e.type === "assistant" && b.text.trim()) result = b.text.trim().split("\n")[0];
    }
  }
  const startedAt = entries[0]!.timestamp;

  // The call that started this run: the latest one before it, unless that
  // call had already returned (then the parent's call line is not on disk yet).
  const call = calls.filter((c) => c.at <= startedAt).at(-1);
  const callResult = call ? results.get(call.id) : undefined;
  const matched = call && (!callResult || callResult.at >= startedAt) ? call : undefined;
  const outcome = matched && callResult;

  return {
    sessionId: entries[0]!.sessionId,
    description: matched?.description ?? null,
    status: outcome ? (outcome.isError ? "failed" : "done") : running ? "running" : "stopped",
    model,
    startedAt,
    endedAt: entries.at(-1)!.timestamp,
    tokens,
    toolCalls,
    result,
  };
}
