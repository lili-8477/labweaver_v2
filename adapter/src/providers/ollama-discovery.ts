// Ollama Cloud's model catalog, read at adapter startup so the model menu
// offers whatever the account can run. /v1/models lists the ids; /api/show
// gives each model's capabilities and context length. Models without tool
// calling are dropped (the agent can't work without tools). Returns null when
// the catalog can't be read, so the caller falls back to its static list.

import type { ModelSpec } from "./registry.js";

const DEFAULT_CONTEXT = 131_072;
const MAX_TOKENS = 32_768;
const TIMEOUT_MS = 10_000;

interface ShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

export async function discoverOllamaModels(
  baseURL: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelSpec[] | null> {
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const get = async <T>(url: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  try {
    const list = await get<{ data?: { id: string }[] }>(`${baseURL.replace(/\/$/, "")}/models`);
    const ids = (list.data ?? []).map((m) => m.id).filter(Boolean);
    const showURL = `${new URL(baseURL).origin}/api/show`;
    const shown = await Promise.all(
      ids.map((id) => get<ShowResponse>(showURL, { model: id }).then((s) => ({ id, s }), () => null)),
    );
    const models = shown
      .filter((x): x is { id: string; s: ShowResponse } => !!x?.s.capabilities?.includes("tools"))
      .map(({ id, s }) => ({
        id,
        label: id,
        contextWindow: contextLength(s.model_info) ?? DEFAULT_CONTEXT,
        maxTokens: MAX_TOKENS,
        vision: s.capabilities!.includes("vision"),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return models.length ? models : null;
  } catch (e) {
    console.warn(`[providers] Ollama model discovery failed, using the static list: ${(e as Error).message}`);
    return null;
  }
}

/** model_info keys the context length as "<architecture>.context_length". */
function contextLength(info: Record<string, unknown> | undefined): number | null {
  for (const [k, v] of Object.entries(info ?? {})) {
    if (k.endsWith("context_length") && typeof v === "number" && v > 0) return v;
  }
  return null;
}
