// End-to-end: DshAcpEngine drives a real `dsh --profile acp` child whose
// ollama-cloud route points at an in-process fake OpenAI-compatible server.
// Covers the tool lifecycle, resume across a process restart, and cancel.
// Requires Node >= 22.19 (dsh's engine floor); skipped otherwise.

import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/engine/types.js";
import { DshAcpConnection } from "../src/dsh/acp-connection.js";
import { DshAcpEngine } from "../src/dsh/engine.js";
import { buildDshPatch, serializePatch } from "../src/dsh/patch.js";
import { buildProviders } from "../src/providers/registry.js";

const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
const nodeOk = major > 22 || (major === 22 && minor >= 19);

interface ChatReq { model: string; messages: Array<{ role: string; content: unknown }> }

/** Scripted model: first call issues a bash tool call, the follow-up answers. */
function startFakeOpenAI(): Promise<{ url: string; requests: ChatReq[]; auth: string[]; close: () => void }> {
  const requests: ChatReq[] = [];
  const auth: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}") as ChatReq;
      requests.push(j);
      auth.push(String(req.headers.authorization));
      // DSH appends injected context after the prompt, so match markers across user messages.
      const prompt = JSON.stringify(j.messages.filter((m) => m.role === "user").map((m) => m.content));
      const afterTool = j.messages.at(-1)?.role === "tool";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
      const chunk = (delta: unknown, finish: string | null = null) =>
        send({ id: "c", object: "chat.completion.chunk", created: 1, model: j.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      if (afterTool) {
        chunk({ role: "assistant", content: "Done: it printed hello." });
        chunk({}, "stop");
      } else if (prompt.includes("ZQ_REMEMBER")) {
        chunk({ role: "assistant", content: "I remember the earlier turn." });
        chunk({}, "stop");
      } else {
        const cmd = prompt.includes("ZQ_SLOW") ? "sleep 30" : "echo hello";
        chunk({ role: "assistant", content: "Running it. " });
        chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: cmd, description: "run" }) } }] });
        chunk({}, "tool_calls");
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as AddressInfo;
    resolve({ url: `http://127.0.0.1:${port}/v1`, requests, auth, close: () => srv.close() });
  }));
}

describe.skipIf(!nodeOk)("DshAcpEngine (real dsh, fake model)", () => {
  let root: string;
  let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
  let patchFile: string;
  const MODEL = "ollama-cloud/fake-model";

  function makeEngine(): DshAcpEngine {
    return new DshAcpEngine(new DshAcpConnection({
      dshBin: createRequire(import.meta.url).resolve("@deepseek-ai/dsh/lib/bin.js"),
      patches: [patchFile],
      env: { ...process.env, DSH_HOME: path.join(root, "dsh"), OLLAMA_API_KEY: "ollama-test-key", DSH_PERMISSION_MODE: "danger-full-access" },
    }));
  }

  async function turn(engine: DshAcpEngine, prompt: string, opts: { resume?: string; signal?: AbortSignal } = {}) {
    const events: AgentEvent[] = [];
    let sessionId = "";
    await engine.runTurn({
      prompt, images: [], cwd: path.join(root, "ws"), model: MODEL, resumeSessionId: opts.resume,
      signal: opts.signal ?? new AbortController().signal,
      onSessionId: (s) => (sessionId = s), onEvent: (e) => events.push(e),
    });
    return { events, sessionId };
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-int-"));
    await fs.mkdir(path.join(root, "ws"));
    fake = await startFakeOpenAI();
    patchFile = path.join(root, "patch.yml");
    const providers = buildProviders({ OLLAMA_BASE_URL: fake.url, OLLAMA_CLOUD_MODELS: "fake-model" });
    await fs.writeFile(patchFile, serializePatch(buildDshPatch({ providers, defaultModel: MODEL, skillDirs: [] })));
  });
  afterAll(async () => {
    fake?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  let firstSession = "";

  it("runs a tool-using turn through the ollama-cloud route", async () => {
    const engine = makeEngine();
    try {
      const { events, sessionId } = await turn(engine, "please run echo");
      firstSession = sessionId;
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(events).toContainEqual({ kind: "text", text: "Running it. " });
      expect(events).toContainEqual({ kind: "tool_call", id: "call_1", name: "bash", input: { command: "echo hello", description: "run" } });
      const result = events.find((e) => e.kind === "tool_result");
      expect(result).toMatchObject({ id: "call_1", isError: false });
      expect((result as { output: string }).output).toContain("hello");
      expect(events).toContainEqual({ kind: "text", text: "Done: it printed hello." });
      expect(fake.auth.every((a) => a === "Bearer ollama-test-key")).toBe(true);
      expect(fake.requests[0]!.model).toBe("fake-model");
    } finally {
      await engine.close();
    }
  }, 120_000);

  it("resumes the session in a fresh dsh process", async () => {
    const engine = makeEngine();
    try {
      const before = fake.requests.length;
      const { events, sessionId } = await turn(engine, "ZQ_REMEMBER do you remember?", { resume: firstSession });
      expect(sessionId).toBe(firstSession);
      expect(events).toContainEqual({ kind: "text", text: "I remember the earlier turn." });
      const history = JSON.stringify(fake.requests[before]!.messages);
      expect(history).toContain("please run echo");
    } finally {
      await engine.close();
    }
  }, 120_000);

  it("falls back to a new session for an unknown (pre-migration) id", async () => {
    const engine = makeEngine();
    try {
      const legacy = "11111111-2222-4333-8444-555555555555";
      const { sessionId } = await turn(engine, "ZQ_REMEMBER do you remember?", { resume: legacy });
      expect(sessionId).not.toBe(legacy);
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await engine.close();
    }
  }, 120_000);

  it("cancels an in-flight tool call on abort", async () => {
    const engine = makeEngine();
    try {
      const ac = new AbortController();
      const started = Date.now();
      const pending = turn(engine, "ZQ_SLOW command please", { signal: ac.signal });
      setTimeout(() => ac.abort(), 4000);
      const { events } = await pending;
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(events.find((e) => e.kind === "tool_result")).toMatchObject({ isError: true });
    } finally {
      await engine.close();
    }
  }, 120_000);
});
