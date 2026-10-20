// Model providers the adapter offers. A model is addressed by a
// "provider/model" reference; the provider id is the DSH route name.
//
// - deepseek-official is built into DSH (key: DEEPSEEK_API_KEY).
// - ollama-cloud is an OpenAI-compatible route DSH serves through its llm-pi-ai
//   adapter; dsh/patch.ts declares it. Its models come from Ollama's live
//   catalog (ollama-discovery.ts), else OLLAMA_CLOUD_MODELS, else the static
//   list below.

import type { ModelOption } from "../rpc-contract.js";

export interface ModelSpec {
  id: string;
  label: string;
  contextWindow: number;
  maxTokens: number;
  vision: boolean;
}

export interface ProviderSpec {
  id: string;
  label: string;
  apiKeyEnv: string;
  /** Present only for routes the adapter must declare to DSH itself. */
  openaiCompatible?: { baseURL: string };
  models: ModelSpec[];
}

const OLLAMA_DEFAULT_MODELS = ["gpt-oss:120b", "deepseek-v4.1-flash", "kimi-k2.6", "glm-5.3", "minimax-m2.7"];
// Fallback-list models that take image input ("vision" in ollama.com/api/show's
// capabilities). Without it dsh refuses to read images for the model.
const OLLAMA_VISION_MODELS = new Set(["deepseek-v4.1-flash", "kimi-k2.6"]);

export const ollamaBaseURL = (env: NodeJS.ProcessEnv = process.env): string =>
  env.OLLAMA_BASE_URL ?? "https://ollama.com/v1";

/** `discovered` is Ollama's live catalog; an explicit OLLAMA_CLOUD_MODELS wins over it. */
export function buildProviders(env: NodeJS.ProcessEnv = process.env, discovered: ModelSpec[] | null = null): ProviderSpec[] {
  const ollamaModels = (env.OLLAMA_CLOUD_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const staticModels = (ollamaModels.length ? ollamaModels : OLLAMA_DEFAULT_MODELS).map((id) => ({
    id,
    label: id,
    contextWindow: 131_072,
    maxTokens: 32_768,
    vision: OLLAMA_VISION_MODELS.has(id),
  }));
  return [
    {
      id: "deepseek-official",
      label: "DeepSeek",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: [
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000, maxTokens: 65_536, vision: false },
        { id: "deepseek-flash", label: "DeepSeek Flash", contextWindow: 1_000_000, maxTokens: 65_536, vision: true },
      ],
    },
    {
      id: "ollama-cloud",
      label: "Ollama Cloud",
      apiKeyEnv: "OLLAMA_API_KEY",
      openaiCompatible: { baseURL: ollamaBaseURL(env) },
      models: !ollamaModels.length && discovered?.length ? discovered : staticModels,
    },
  ];
}

export const DEFAULT_MODEL_REF = "deepseek-official/deepseek-v4-pro";

/** Split "provider/model" on the first slash (Ollama ids contain ':' but no '/'). */
export function parseModelRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function formatModelRef(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function findModel(providers: ProviderSpec[], ref: string): { provider: ProviderSpec; model: ModelSpec } | null {
  const parsed = parseModelRef(ref);
  if (!parsed) return null;
  const provider = providers.find((p) => p.id === parsed.provider);
  const model = provider?.models.find((m) => m.id === parsed.model);
  return provider && model ? { provider, model } : null;
}

/** A stored ref that no longer resolves (e.g. a legacy Claude id) falls back to the default. */
export function resolveModelRef(providers: ProviderSpec[], ref: string | undefined): string {
  return ref && findModel(providers, ref) ? ref : DEFAULT_MODEL_REF;
}

export function listModelOptions(providers: ProviderSpec[], env: NodeJS.ProcessEnv = process.env): ModelOption[] {
  return providers.flatMap((p) =>
    p.models.map((m) => ({
      ref: formatModelRef(p.id, m.id),
      label: `${p.label} · ${m.label}`,
      provider: p.id,
      available: Boolean(env[p.apiKeyEnv]),
    })),
  );
}
