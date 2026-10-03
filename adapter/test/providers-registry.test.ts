import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_REF,
  buildProviders,
  findModel,
  listModelOptions,
  parseModelRef,
  resolveModelRef,
} from "../src/providers/registry.js";

describe("providers registry", () => {
  it("parses refs on the first slash so ollama tags survive", () => {
    expect(parseModelRef("ollama-cloud/gpt-oss:120b")).toEqual({ provider: "ollama-cloud", model: "gpt-oss:120b" });
    expect(parseModelRef("no-slash")).toBeNull();
    expect(parseModelRef("/x")).toBeNull();
    expect(parseModelRef("x/")).toBeNull();
  });

  it("declares ollama cloud as an OpenAI-compatible route with an overridable model list", () => {
    const providers = buildProviders({ OLLAMA_CLOUD_MODELS: "a:1, b:2", OLLAMA_BASE_URL: "http://local/v1" });
    const ollama = providers.find((p) => p.id === "ollama-cloud")!;
    expect(ollama.openaiCompatible).toEqual({ baseURL: "http://local/v1" });
    expect(ollama.apiKeyEnv).toBe("OLLAMA_API_KEY");
    expect(ollama.models.map((m) => m.id)).toEqual(["a:1", "b:2"]);
    expect(providers.find((p) => p.id === "deepseek-official")!.openaiCompatible).toBeUndefined();
  });

  it("falls back to the default for unknown or legacy refs", () => {
    const providers = buildProviders({});
    expect(resolveModelRef(providers, "claude-sonnet-4-6")).toBe(DEFAULT_MODEL_REF);
    expect(resolveModelRef(providers, undefined)).toBe(DEFAULT_MODEL_REF);
    expect(resolveModelRef(providers, "ollama-cloud/gpt-oss:120b")).toBe("ollama-cloud/gpt-oss:120b");
    expect(findModel(providers, DEFAULT_MODEL_REF)).not.toBeNull();
  });

  it("marks providers available only when their key env is set", () => {
    const opts = listModelOptions(buildProviders({}), { OLLAMA_API_KEY: "k" });
    expect(opts.filter((o) => o.provider === "ollama-cloud").every((o) => o.available)).toBe(true);
    expect(opts.filter((o) => o.provider === "deepseek-official").every((o) => !o.available)).toBe(true);
  });
});
