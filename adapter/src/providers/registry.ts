// Model providers the adapter offers. A model is addressed by a
// "provider/model" reference; the provider id is the DSH route name.
//
// - deepseek-official is built into DSH (key: DEEPSEEK_API_KEY).
// - ollama-cloud is an OpenAI-compatible route DSH serves through its llm-pi-ai
//   adapter; dsh/patch.ts declares it.

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

export interface ModelOption {
  ref: string;
  label: string;
  provider: string;
  available: boolean;
}

const OLLAMA_DEFAULT_MODELS = ["gpt-oss:120b", "deepseek-v4.1-flash", "kimi-k2.6", "glm-5.3", "minimax-m2.7"];

export function buildProviders(env: NodeJS.ProcessEnv = process.env): ProviderSpec[] {
  const ollamaModels = (env.OLLAMA_CLOUD_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
      openaiCompatible: { baseURL: env.OLLAMA_BASE_URL ?? "https://ollama.com/v1" },
      models: (ollamaModels.length ? ollamaModels : OLLAMA_DEFAULT_MODELS).map((id) => ({
        id,
        label: id,
        contextWindow: 131_072,
        maxTokens: 32_768,
        vision: false,
      })),
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
