import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readChatStats } from "../src/chat-stats.js";

const cwd = "/workspace";
const parent = "11111111-0000-0000-0000-000000000000";
const usage = (input: number, output: number, cacheRead = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0,
});
const at = (s: number) => `2026-10-07T10:00:${String(s).padStart(2, "0")}.000Z`;

describe("readChatStats", () => {
  let home: string;
  let dir: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "labweaver-stats-"));
    dir = path.join(home, ".claude", "projects", "-workspace");
    await fs.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const write = (id: string, lines: object[]) =>
    fs.writeFile(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const child = (id: string, start: number, lines: object[], parentSessionId = parent) =>
    write(id, [
      { type: "user", sessionId: id, parentSessionId, isSidechain: true, timestamp: at(start), message: { role: "user", content: "# reviewer" } },
      ...lines.map((l, i) => ({ sessionId: id, parentSessionId, isSidechain: true, timestamp: at(start + i + 1), ...l })),
    ]);

  const subagentCall = (id: string, s: number, description: string) => ({
    type: "assistant", timestamp: at(s),
    message: { role: "assistant", content: [{ type: "tool_use", id, name: "subagent", input: { description } }] },
  });
  const toolResult = (id: string, s: number, isError = false) => ({
    type: "user", timestamp: at(s),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }] },
  });

  it("sums the chat's turns and matches each sidechain to its subagent call", async () => {
    await write(parent, [
      { type: "user", timestamp: at(0), message: { role: "user", content: "go" } },
      { type: "assistant", timestamp: at(1), message: { role: "assistant", content: [{ type: "text", text: "a" }], usage: usage(100, 10, 1000) } },
      subagentCall("c1", 2, "Review step one"),
      toolResult("c1", 10),
      subagentCall("c2", 11, "Review step two"),
      toolResult("c2", 20, true),
      { type: "assistant", timestamp: at(21), message: { role: "assistant", content: [{ type: "text", text: "b" }], usage: usage(50, 5) } },
    ]);
    await child("aaaa", 3, [
      { type: "assistant", message: { role: "assistant", model: "ds/flash", content: [{ type: "tool_use", id: "t", name: "bash", input: {} }], usage: usage(20, 2) } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reviewer: approved\nmore" }], usage: usage(30, 3) } },
    ]);
    await child("bbbb", 12, [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x" }], usage: usage(1, 1) } }]);
    await child("cccc", 5, [], "someone-else");

    const stats = await readChatStats(home, cwd, parent, false);

    expect(stats.main).toEqual({ input: 150, output: 15, cacheRead: 1000, cacheWrite: 0 });
    expect(stats.turns).toBe(2);
    expect(stats.lastTurn).toEqual({ input: 50, output: 5, cacheRead: 0, cacheWrite: 0 });
    expect(stats.subagents.map((s) => [s.description, s.status])).toEqual([
      ["Review step one", "done"],
      ["Review step two", "failed"],
    ]);
    expect(stats.subagents[0]).toMatchObject({
      model: "ds/flash", toolCalls: 1, result: "reviewer: approved",
      tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("reports a run with no result as running while the turn is live, else stopped", async () => {
    // The parent's call line is still held in memory: the latest call on disk already returned.
    await write(parent, [subagentCall("c1", 1, "Earlier review"), toolResult("c1", 2)]);
    await child("dddd", 5, []);

    const live = await readChatStats(home, cwd, parent, true);
    expect(live.subagents[0]).toMatchObject({ description: null, status: "running" });
    const after = await readChatStats(home, cwd, parent, false);
    expect(after.subagents[0]!.status).toBe("stopped");
  });
});
