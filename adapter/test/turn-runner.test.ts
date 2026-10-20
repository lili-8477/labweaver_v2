import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEngine, EngineTurnArgs } from "../src/engine/types.js";
import { projectItems } from "../src/chat-items.js";
import type { ChatItem } from "../src/rpc-contract.js";
import { readTranscript } from "../src/transcript/read.js";
import { runTurn } from "../src/turn-runner.js";
import type { StreamEvent } from "../src/types.js";

const SID = "ae132e5b-0f2a-4428-a3cf-c057a8829659";

class FakeEngine implements AgentEngine {
  calls: EngineTurnArgs[] = [];
  async runTurn(args: EngineTurnArgs): Promise<void> {
    this.calls.push(args);
    args.onSessionId(SID);
    args.onEvent({ kind: "text", text: "Let me look." });
    args.onEvent({ kind: "tool_call", id: "call_1", name: "bash", input: { command: "ls" } });
    args.onEvent({ kind: "tool_result", id: "call_1", output: "a.txt", isError: false });
    args.onEvent({ kind: "usage", contextTokens: 7012, contextWindow: 131072 });
  }
  async close(): Promise<void> {}
}

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "turn-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

describe("runTurn", () => {
  it("streams chat items that end exactly where reloading the transcript starts", async () => {
    await fs.mkdir(path.join(home, ".labweaver", "commands"), { recursive: true });
    await fs.writeFile(path.join(home, ".labweaver", "commands", "recall.md"), "Search memory for $ARGUMENTS.");
    const engine = new FakeEngine();
    const events: StreamEvent[] = [];
    const sessions: string[] = [];
    await runTurn(engine, {
      chatId: "chat-1", prompt: "/recall fusion", images: [], cwd: "/workspace", home,
      model: "ollama-cloud/gpt-oss:120b", resumeSessionId: undefined, signal: new AbortController().signal,
      onEvent: (e) => events.push(e), onSessionId: (s) => { sessions.push(s); },
    });

    expect(engine.calls[0]!.prompt).toBe("Search memory for fusion.");
    expect(engine.calls[0]!.model).toBe("ollama-cloud/gpt-oss:120b");
    expect(sessions).toEqual([SID]);

    // What the frontend holds after upserting every streamed item…
    const live = new Map<string, ChatItem>();
    for (const e of events) {
      if (e.type !== "item" || e.chat_id !== "chat-1") throw new Error(`unexpected event ${e.type}`);
      live.set(e.item.id, e.item);
    }
    // …is what get_chat_items returns for the stored transcript.
    const reloaded = projectItems((await readTranscript(home, "/workspace", SID)).entries);
    expect([...live.values()]).toEqual(reloaded);
    // The transcript keeps the user's original text, before command expansion.
    expect(reloaded.map((it) => it.kind)).toEqual(["user", "text", "tool"]);
    expect(reloaded[0]).toMatchObject({ text: "/recall fusion" });
    expect(reloaded[2]).toMatchObject({ name: "bash", output: "a.txt", isError: false });
  });
});
