import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectItems } from "../src/chat-items.js";
import { readTranscript, transcriptPath } from "../src/transcript/read.js";
import { ClaudeTranscriptWriter } from "../src/transcript/claude-jsonl.js";

const SID = "f47b5dd1-cdfd-4b66-93d4-57fc576ed5ec";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("ClaudeTranscriptWriter", () => {
  let home: string;
  beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-")); });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const items = async (sid: string) => projectItems((await readTranscript(home, "/workspace", sid)).entries);

  async function writeTurn(): Promise<void> {
    const w = new ClaudeTranscriptWriter({ home, cwd: "/workspace", sessionId: SID, model: "ollama-cloud/gpt-oss:120b" });
    w.userPrompt("run echo");
    w.event({ kind: "text", text: "Let me look." });
    w.event({ kind: "tool_call", id: "call_1", name: "bash", input: { command: "echo hi" } });
    w.event({ kind: "tool_result", id: "call_1", output: "hi", isError: false });
    w.event({ kind: "usage", contextTokens: 10, contextWindow: 100 });
    w.event({ kind: "text", text: "Done." });
    await w.flush();
  }

  it("round-trips into chat items (get_chat_items)", async () => {
    await writeTurn();
    expect(await items(SID)).toEqual([
      { kind: "user", id: expect.stringMatching(UUID_RE), text: "run echo" },
      { kind: "text", id: expect.stringMatching(UUID_RE), text: "Let me look." },
      {
        kind: "tool", id: "call_1", name: "bash", input: { command: "echo hi" }, output: "hi", isError: false,
        startedAt: expect.any(String), endedAt: expect.any(String),
      },
      { kind: "text", id: expect.stringMatching(UUID_RE), text: "Done." },
    ]);
  });

  it("puts the turn's token totals on its last assistant entry, Claude-style", async () => {
    const w = new ClaudeTranscriptWriter({ home, cwd: "/workspace", sessionId: SID, model: "m" });
    w.userPrompt("hi");
    w.event({ kind: "text", text: "Hello." });
    w.event({ kind: "tokens", input: 120, output: 30, cacheRead: 64, cacheWrite: 0 });
    await w.flush();
    const lines = (await fs.readFile(transcriptPath(home, "/workspace", SID), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1].message.usage).toEqual({
      input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 64, cache_creation_input_tokens: 0,
    });
  });

  it("writes the fields the hub indexer requires, chained by parentUuid", async () => {
    await writeTurn();
    const lines = (await fs.readFile(transcriptPath(home, "/workspace", SID), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(5);
    expect(lines[0].parentUuid).toBeNull();
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i].uuid).toMatch(UUID_RE);
      expect(lines[i].sessionId).toBe(SID);
      expect(Number.isNaN(Date.parse(lines[i].timestamp))).toBe(false);
      if (i > 0) expect(lines[i].parentUuid).toBe(lines[i - 1].uuid);
    }
    expect(lines[1].message.model).toBe("ollama-cloud/gpt-oss:120b");
  });

  it("follows a continuation link to the replaced session's history", async () => {
    await writeTurn();
    const next = "0b7e1c4a-9f1e-4c55-8a51-1f2d3c4b5a69";
    const w = new ClaudeTranscriptWriter({ home, cwd: "/workspace", sessionId: next, model: "m" });
    w.continues(SID);
    w.userPrompt("again");
    await w.flush();
    const all = await items(next);
    expect(all).toHaveLength(5);
    expect(all.at(-1)).toMatchObject({ kind: "user", text: "again" });
  });

  it("appends across turns of the same session", async () => {
    await writeTurn();
    await writeTurn();
    expect((await items(SID)).filter((it) => it.kind === "user")).toHaveLength(2);
  });
});
