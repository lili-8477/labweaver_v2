import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEngine } from "../src/engine/types.js";
import { buildProviders } from "../src/providers/registry.js";
import { RpcRouter, type RpcDeps } from "../src/rpc.js";

const engine: AgentEngine = { runTurn: async () => undefined, close: async () => undefined };

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-model-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

describe("model RPCs", () => {
  function router(): RpcRouter {
    const deps: RpcDeps = {
      serviceId: "s", workspaceRoot: "/tmp/ws", chats: {} as RpcDeps["chats"], home, defaultProjectCwd: "/tmp/ws",
      publishStream: () => undefined, publishRaw: () => undefined, streamSubject: (id) => id,
      kernelBridgePath: "/dev/null", memory: null, share: null,
      engine, providers: buildProviders({}),
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
