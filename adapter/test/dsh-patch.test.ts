import { describe, expect, it } from "vitest";
import { buildDshPatch, serializePatch } from "../src/dsh/patch.js";
import { buildProviders } from "../src/providers/registry.js";

describe("buildDshPatch", () => {
  const providers = buildProviders({ OLLAMA_CLOUD_MODELS: "gpt-oss:120b" });

  it("declares only OpenAI-compatible providers as llm-pi-ai routes", () => {
    const rows = buildDshPatch({ providers, defaultModel: "ollama-cloud/gpt-oss:120b", skillDirs: [] });
    const llm = rows.find((r) => r.id === "llm-pi-ai") as { config: { providers: Record<string, any> } };
    expect(Object.keys(llm.config.providers)).toEqual(["ollama-cloud"]);
    expect(llm.config.providers["ollama-cloud"]).toMatchObject({
      apiKeyEnv: "OLLAMA_API_KEY",
      api: "openai-completions",
      baseURL: "https://ollama.com/v1",
      models: [{ id: "gpt-oss:120b", input: ["text"], reasoningEfforts: false }],
    });
  });

  it("sets the ACP default route and skill dirs", () => {
    const rows = buildDshPatch({ providers, defaultModel: "deepseek-official/deepseek-v4-pro", skillDirs: ["/a", "/b"] });
    expect(rows).toContainEqual({ id: "acp", config: { provider: "deepseek-official", model: "deepseek-v4-pro" } });
    expect(rows).toContainEqual({ id: "skill-filesystem", config: { customSkillDirs: ["/a", "/b"] } });
  });

  it("mounts claude-code hooks only when a config path is given", () => {
    const without = buildDshPatch({ providers, defaultModel: "deepseek-official/deepseek-v4-pro", skillDirs: [] });
    expect(without.some((r) => "insert" in r)).toBe(false);
    const withHooks = buildDshPatch({
      providers, defaultModel: "deepseek-official/deepseek-v4-pro", skillDirs: [], hooksConfigPath: "/h/settings.json",
    });
    expect(withHooks).toContainEqual({
      insert: [{ id: "hooks-claude-code", name: "@deepseek-ai/dsh-hooks-claude-code", config: { configPath: "/h/settings.json" } }],
    });
  });

  it("inserts the adapter's dsh plugins by URL alongside hooks", () => {
    const rows = buildDshPatch({
      providers, defaultModel: "deepseek-official/deepseek-v4-pro", skillDirs: [],
      hooksConfigPath: "/h/settings.json", pluginsDirUrl: "file:///opt/adapter/dsh-plugins/",
    });
    expect(rows.filter((r) => "insert" in r)).toEqual([{
      insert: [
        { id: "hooks-claude-code", name: "@deepseek-ai/dsh-hooks-claude-code", config: { configPath: "/h/settings.json" } },
        { id: "next-step", name: "file:///opt/adapter/dsh-plugins/next-step.js" },
        { id: "tick", name: "file:///opt/adapter/dsh-plugins/tick.js" },
        { id: "usage", name: "file:///opt/adapter/dsh-plugins/usage.js" },
        { id: "sidechain", name: "file:///opt/adapter/dsh-plugins/sidechain.js" },
      ],
    }]);
  });

  it("mounts .mcp.json servers process-wide through dsh-mcp-client", () => {
    const rows = buildDshPatch({
      providers, defaultModel: "deepseek-official/deepseek-v4-pro", skillDirs: [],
      mcpServers: [
        { name: "labweaver-memory", command: "/usr/local/bin/labweaver-memory-mcp", args: [], env: [{ name: "USERNAME", value: "devuser" }] },
        { type: "http", name: "web", url: "http://x/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] },
      ],
    });
    expect(rows.filter((r) => "insert" in r)).toEqual([{
      insert: [
        {
          id: "mcp-labweaver-memory", name: "@deepseek-ai/dsh-mcp-client",
          config: { serverName: "labweaver-memory", transport: "stdio", command: "/usr/local/bin/labweaver-memory-mcp", args: [], env: { USERNAME: "devuser" } },
        },
        {
          id: "mcp-web", name: "@deepseek-ai/dsh-mcp-client",
          config: { serverName: "web", transport: "streamable-http", url: "http://x/mcp", headers: { Authorization: "Bearer t" } },
        },
      ],
    }]);
  });

  it("rejects malformed default refs and serializes as JSON", () => {
    expect(() => buildDshPatch({ providers, defaultModel: "bad", skillDirs: [] })).toThrow(/invalid default/);
    const rows = buildDshPatch({ providers, defaultModel: "deepseek-official/deepseek-v4-pro", skillDirs: [] });
    expect(JSON.parse(serializePatch(rows))).toEqual(rows);
  });
});
