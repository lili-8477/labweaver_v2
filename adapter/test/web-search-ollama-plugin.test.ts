import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain-ESM dsh plugin, no type declarations
import { apply, toSearchResult } from "../dsh-plugins/web-search-ollama.js";

interface Provider {
  id: string;
  available(): boolean;
  search(req: { query: string; maxResults?: number }): Promise<{ sources: { url: string; title?: string; snippet?: string }[] }>;
}

function register(): Provider {
  let provider: Provider | undefined;
  apply({ web: { registerSearchProvider: (p: Provider) => { provider = p; } } });
  return provider!;
}

describe("web-search-ollama plugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("maps results to sources, deduping URLs and clipping page text", () => {
    const r = toSearchResult({
      results: [
        { title: "A", url: "https://a", content: "x".repeat(2000) },
        { title: "A again", url: "https://a", content: "dup" },
        { title: "", url: "https://b", content: "" },
      ],
    });
    expect(r.sources.map((s: { url: string }) => s.url)).toEqual(["https://a", "https://b"]);
    expect(r.sources[0].snippet.length).toBe(1201);
    expect(r.sources[1]).toEqual({ url: "https://b" });
  });

  it("is available only with OLLAMA_API_KEY and posts the query with the key", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "");
    const p = register();
    expect(p.id).toBe("ollama");
    expect(p.available()).toBe(false);

    vi.stubEnv("OLLAMA_API_KEY", "k");
    expect(p.available()).toBe(true);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: "T", url: "https://t", content: "c" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const res = await p.search({ query: "leiden", maxResults: 50 });
    expect(res.sources).toEqual([{ url: "https://t", title: "T", snippet: "c" }]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toEqual({ query: "leiden", max_results: 10 });
  });

  it("surfaces HTTP errors", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    await expect(register().search({ query: "q" })).rejects.toThrow(/HTTP 401.*unauthorized/);
  });
});
