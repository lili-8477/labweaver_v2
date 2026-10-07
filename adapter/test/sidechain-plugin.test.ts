import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// dsh-plugins/sidechain.js resolves ~/.claude per write via homedir().
const home = mkdtempSync(path.join(tmpdir(), "sidechain-home-"));

type Listener = (session: unknown, event: unknown) => void;
let onEvent: Listener;

beforeAll(async () => {
  process.env.HOME = home;
  const pluginPath = "../dsh-plugins/sidechain.js";
  const plugin = await import(pluginPath);
  plugin.apply({
    on: (event: string, fn: Listener) => { if (event === "session/event") onEvent = fn; },
    logger: { warn: () => undefined },
  });
});

const child = { header: { id: "child-1", parentSession: "root-1", delegationDepth: 1, cwd: "/workspace" } };
const root = { header: { id: "root-1", cwd: "/workspace" } };
const text = (t: string) => [{ type: "text", text: t }];

describe("sidechain plugin", () => {
  it("writes a child session as a Claude-format sidechain transcript, chained and linked to its parent", () => {
    onEvent(child, { type: "user/message", data: { content: text("Run QC") } });
    onEvent(child, { type: "user/message", data: { content: text("skills: …"), source: { kind: "skill-catalog", form: "catalog" } } });
    onEvent(child, { type: "tool/call", data: { callId: "c1", name: "bash", arguments: '{"command":"ls"}' } });
    onEvent(child, { type: "tool/result", data: { message: { toolCallId: "c1", content: text("a.h5ad"), isError: false } } });
    onEvent(child, {
      type: "assistant/message",
      data: {
        message: { content: [{ type: "reasoning", text: "hmm" }, ...text("QC done")], source: { provider: "ollama-cloud", model: "m1" } },
        usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 40 },
      },
    });
    onEvent(child, { type: "turn/end", data: {} }); // not a transcript entry
    onEvent(root, { type: "user/message", data: { content: text("parent") } }); // the adapter owns the parent

    const file = path.join(home, ".claude", "projects", "-workspace", "child-1.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(lines.every((l) => l.isSidechain && l.sessionId === "child-1" && l.parentSessionId === "root-1")).toBe(true);
    expect(lines[0].parentUuid).toBeNull();
    for (let i = 1; i < lines.length; i++) expect(lines[i].parentUuid).toBe(lines[i - 1].uuid);
    expect(lines[0].message).toEqual({ role: "user", content: "Run QC" });
    expect(lines[1].message.content).toEqual([{ type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } }]);
    expect(lines[2].message.content).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "a.h5ad", is_error: false }]);
    expect(lines[3].message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "QC done" }],
      model: "ollama-cloud/m1",
      usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
    });
  });
});
