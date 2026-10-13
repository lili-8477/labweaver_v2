// DeepSeek Harness plugin "web-search-ollama". dsh loads this file itself, so
// it is plain ESM, not TypeScript. Mounted by the adapter's cordis patch, which
// also pins it as the web service's search provider: see src/dsh/patch.ts.
//
// Backs the model's web_search tool with Ollama's web search API, using the
// same OLLAMA_API_KEY as the Ollama Cloud models. (dsh-base's default backend,
// DeepSeek native search, needs DEEPSEEK_API_KEY and costs a model turn.)

export const name = "web-search-ollama";
export const inject = ["web"];

const ENDPOINT = process.env.OLLAMA_WEB_SEARCH_URL ?? "https://ollama.com/api/web_search";
// The API caps max_results at 10. Each result's content is page text, so the
// snippet is clipped; web_fetch reads the full page.
const MAX_RESULTS = 10;
const SNIPPET_CHARS = 1200;

/** Map an Ollama web_search response to dsh's WebSearchResult. */
export function toSearchResult(body) {
  const seen = new Set();
  const sources = [];
  for (const r of body?.results ?? []) {
    if (!r?.url || seen.has(r.url)) continue;
    seen.add(r.url);
    const text = (r.content ?? "").trim();
    sources.push({
      url: r.url,
      ...(r.title ? { title: r.title } : {}),
      ...(text ? { snippet: text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text } : {}),
    });
  }
  return { sources, truncated: false };
}

export function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: "ollama",
    available: () => Boolean(process.env.OLLAMA_API_KEY),
    async search(request, signal) {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: request.query,
          max_results: Math.min(request.maxResults ?? MAX_RESULTS, MAX_RESULTS),
        }),
        signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Ollama web search failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
      }
      return toSearchResult(await res.json());
    },
  });
}
