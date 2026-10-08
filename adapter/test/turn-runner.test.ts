import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEngine, EngineTurnArgs } from "../src/engine/types.js";
import { readSessionMessages } from "../src/history.js";
import { RpcRouter, type RpcDeps } from "../src/rpc.js";
import { buildProviders } from "../src/providers/registry.js";
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
  it("streams the frontend contract, records the transcript and expands commands", async () => {
    await fs.mkdir(path.join(home, ".claude", "commands"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", "commands", "recall.md"), "Search memory for $ARGUMENTS.");
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
    expect(events.map((e) => e.type)).toEqual(["chunk", "step_message", "step_message", "step_message", "chat_finished"]);
    const toolCall = events[1] as Extract<StreamEvent, { type: "step_message" }>;
    expect(toolCall.step_message.tool_calls![0]!.function).toEqual({ name: "bash", arguments: '{"command":"ls"}' });
    const final = events[3] as Extract<StreamEvent, { type: "step_message" }>;
    expect(final.step_message._metadata!.total_tokens).toBe(7012);

    // Transcript keeps the user's original text, as Claude Code did.
    const msgs = await readSessionMessages(home, "/workspace", SID);
    expect(msgs[0]).toEqual({ role: "user", content: "/recall fusion" });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "tool"]);
  });

  it("skips chat_finished when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const events: StreamEvent[] = [];
    await runTurn(new FakeEngine(), {
      chatId: "c", prompt: "hi", images: [], cwd: "/workspace", home, model: "m/x",
      resumeSessionId: undefined, signal: ac.signal, onEvent: (e) => events.push(e), onSessionId: () => undefined,
    });
    expect(events.some((e) => e.type === "chat_finished")).toBe(false);
  });
});

describe("model RPCs", () => {
  function router(): RpcRouter {
    const deps: RpcDeps = {
      serviceId: "s", workspaceRoot: "/tmp/ws", chats: {} as RpcDeps["chats"], home, defaultProjectCwd: "/tmp/ws",
      publishStream: () => undefined, publishRaw: () => undefined, streamSubject: (id) => id,
      kernelBridgePath: "/dev/null", memory: null, share: null,
      engine: new FakeEngine(), providers: buildProviders({}),
    };
    return new RpcRouter(deps);
  }

  beforeEach(async () => {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-sonnet-4-6", hooks: {} }));
  });

  it("maps a legacy Claude model to the default and lists both providers", async () => {
    const r = router();
    expect(await r.dispatch("get_model", {})).toEqual({ success: true, model: "deepseek-official/deepseek-v4-pro" });
    const { models } = (await r.dispatch("list_models", {})) as { models: Array<{ provider: string }> };
    expect(new Set(models.map((m) => m.provider))).toEqual(new Set(["deepseek-official", "ollama-cloud"]));
  });

  it("persists a valid selection without clobbering hooks, and rejects unknown models", async () => {
    const r = router();
    await r.dispatch("set_model", { model: "ollama-cloud/gpt-oss:120b" });
    expect(await r.dispatch("get_model", {})).toEqual({ success: true, model: "ollama-cloud/gpt-oss:120b" });
    const saved = JSON.parse(await fs.readFile(path.join(home, ".claude", "settings.json"), "utf8"));
    expect(saved.hooks).toEqual({});
    await expect(r.dispatch("set_model", { model: "claude-opus-4-8" })).rejects.toThrow(/unknown model/);
  });
});
