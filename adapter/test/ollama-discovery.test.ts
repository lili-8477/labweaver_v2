import { describe, expect, it, vi } from "vitest";
import { discoverOllamaModels } from "../src/providers/ollama-discovery.js";
import { buildProviders } from "../src/providers/registry.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(show: Record<string, unknown>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === "https://ollama.test/v1/models") {
      return json({ data: Object.keys(show).map((id) => ({ id })) });
    }
    if (url === "https://ollama.test/api/show") {
      const { model } = JSON.parse(String(init?.body));
      return show[model] === undefined ? json({ error: "not found" }, 404) : json(show[model]);
    }
    return json({}, 404);
  }) as typeof fetch;
}

describe("discoverOllamaModels", () => {
  it("keeps tool-capable models with their vision flag and context length, sorted", async () => {
    const models = await discoverOllamaModels("https://ollama.test/v1", "k", fakeFetch({
      "z-vision": { capabilities: ["completion", "tools", "vision"], model_info: { "arch.context_length": 262144 } },
      "a-text": { capabilities: ["completion", "tools"], model_info: {} },
      "no-tools": { capabilities: ["completion"] },
    }));
    expect(models).toEqual([
      { id: "a-text", label: "a-text", contextWindow: 131_072, maxTokens: 32_768, vision: false },
      { id: "z-vision", label: "z-vision", contextWindow: 262_144, maxTokens: 32_768, vision: true },
    ]);
  });

  it("returns null when the catalog can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = (async () => json({}, 500)) as unknown as typeof fetch;
    expect(await discoverOllamaModels("https://ollama.test/v1", "k", failing)).toBeNull();
    warn.mockRestore();
  });

  it("feeds buildProviders, unless OLLAMA_CLOUD_MODELS pins the list", () => {
    const discovered = [{ id: "m", label: "m", contextWindow: 1, maxTokens: 1, vision: true }];
    const ollama = (env: NodeJS.ProcessEnv) => buildProviders(env, discovered).find((p) => p.id === "ollama-cloud")!;
    expect(ollama({}).models).toEqual(discovered);
    expect(ollama({ OLLAMA_CLOUD_MODELS: "x" }).models.map((m) => m.id)).toEqual(["x"]);
  });
});
