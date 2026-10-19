import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatItemProjector, MAX_TOOL_OUTPUT_CHARS, projectItems } from "../src/chat-items.js";
import { readTranscript } from "../src/transcript/read.js";

const T0 = "2026-10-19T10:00:00.000Z";
const T1 = "2026-10-19T10:00:02.500Z";

const user = (content: unknown, extra: object = {}) => ({ type: "user", uuid: `u-${JSON.stringify(content).length}`, timestamp: T0, message: { role: "user", content }, ...extra });
const assistant = (uuid: string, content: unknown[], timestamp = T0) => ({ type: "assistant", uuid, timestamp, message: { role: "assistant", content } });
const result = (id: string, content: unknown, isError = false, timestamp = T1) =>
  user([{ type: "tool_result", tool_use_id: id, content, is_error: isError }], { uuid: `r-${id}`, timestamp });

describe("projectItems", () => {
  it("pairs each tool call with its result: name, input, output, error flag and times", () => {
    const items = projectItems([
      user("run ls"),
      assistant("a1", [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }]),
      result("call_1", "a.txt"),
      assistant("a2", [{ type: "tool_use", id: "call_2", name: "bash", input: { command: "false" } }]),
      result("call_2", [{ type: "text", text: "exit 1" }], true),
    ]);
    expect(items).toEqual([
      { kind: "user", id: expect.any(String), text: "run ls" },
      { kind: "tool", id: "call_1", name: "bash", input: { command: "ls" }, output: "a.txt", isError: false, startedAt: T0, endedAt: T1 },
      { kind: "tool", id: "call_2", name: "bash", input: { command: "false" }, output: "exit 1", isError: true, startedAt: T0, endedAt: T1 },
    ]);
  });

  it("keeps text and tools interleaved, joining consecutive text into one item", () => {
    const items = projectItems([
      user("go"),
      assistant("a1", [{ type: "text", text: "Acknowledged." }]),
      assistant("a2", [{ type: "text", text: "Reading the plan." }]),
      assistant("a3", [{ type: "tool_use", id: "c", name: "read", input: {} }]),
      result("c", "plan"),
      assistant("a4", [{ type: "text", text: "Done." }]),
    ]);
    expect(items.map((it) => it.kind)).toEqual(["user", "text", "tool", "text"]);
    expect(items[1]).toEqual({ kind: "text", id: "a1", text: "Acknowledged.\n\nReading the plan." });
    expect(items[3]).toEqual({ kind: "text", id: "a4", text: "Done." });
  });

  it("drops what isn't the conversation: thinking, synthetic user text, skill payloads, other entry types", () => {
    const items = projectItems([
      { type: "queue-operation", operation: "enqueue" },
      user([{ type: "text", text: "explain QC" }]),
      assistant("think", [{ type: "thinking", thinking: "hmm" }]),
      assistant("a1", [{ type: "tool_use", id: "s", name: "Skill", input: { skill: "qc" } }]),
      result("s", ""),
      user([{ type: "text", text: "Base directory for this skill: /home/node/.labweaver/skills/qc\n\n# QC" }]),
      user("<system-reminder>…</system-reminder>", { isMeta: true }),
      assistant("a2", [{ type: "text", text: "Use MAD thresholds." }]),
    ]);
    expect(items.map((it) => it.kind)).toEqual(["user", "tool", "text"]);
    expect(items[0]).toMatchObject({ text: "explain QC" });
  });

  it("strips the injected session-context block from the user's text", () => {
    const [it0] = projectItems([user("plot umap\n\n<session-context>\nproject at /x\n</session-context>")]);
    expect(it0).toMatchObject({ kind: "user", text: "plot umap" });
  });

  it("caps tool output and shows a result whose call it never saw", () => {
    const items = projectItems([result("orphan", "y".repeat(MAX_TOOL_OUTPUT_CHARS + 10))]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", id: "orphan", name: "tool" });
    const out = (items[0] as { output: string }).output;
    expect(out.startsWith("y".repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
    expect(out.endsWith("[truncated]")).toBe(true);
  });

  it("reports only what each entry changed, so a stream of pushes upserts to the same items", () => {
    const p = new ChatItemProjector();
    expect(p.push(assistant("a1", [{ type: "text", text: "One." }]))).toEqual([{ kind: "text", id: "a1", text: "One." }]);
    expect(p.push(assistant("a2", [{ type: "text", text: "Two." }]))).toEqual([{ kind: "text", id: "a1", text: "One.\n\nTwo." }]);
    expect(p.push(assistant("a3", [{ type: "tool_use", id: "c", name: "bash", input: {} }]))).toMatchObject([{ id: "c" }]);
    const [res] = p.push(result("c", "ok"));
    expect(res).toMatchObject({ id: "c", output: "ok", endedAt: T1 });
  });
});

describe("readTranscript", () => {
  let home: string;
  const cwd = "/workspace";
  const file = (sid: string) => path.join(home, ".labweaver", "projects", "-workspace", `${sid}.jsonl`);
  const write = (sid: string, lines: object[], tail = "") =>
    fs.writeFile(file(sid), lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + tail);

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-read-"));
    await fs.mkdir(path.dirname(file("x")), { recursive: true });
  });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

  it("is empty when the session has no file", async () => {
    expect(await readTranscript(home, cwd, "missing")).toEqual({ entries: [], sessions: new Set(["missing"]) });
  });

  it("splices in the sessions a continuation link points at, and skips a torn last line", async () => {
    await write("old", [user("first")]);
    await write("new", [{ type: "labweaver-continuation", previousSessionId: "old" }, user("second")], '{"type":"assistant","mess');
    const t = await readTranscript(home, cwd, "new");
    expect(t.sessions).toEqual(new Set(["new", "old"]));
    expect(projectItems(t.entries).map((it) => it.kind === "user" && it.text)).toEqual(["first", "second"]);
  });
});
