import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { takeTurnUsage } from "../src/dsh/usage.js";

describe("takeTurnUsage", () => {
  it("sums the recorded calls and removes the file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "usage-"));
    const file = path.join(dir, "s1.jsonl");
    writeFileSync(file, [
      JSON.stringify({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 }),
      "{torn",
      JSON.stringify({ inputTokens: 30, outputTokens: 5, totalTokens: 35 }),
      "",
    ].join("\n"));
    expect(await takeTurnUsage(dir, "s1")).toEqual({ input: 130, output: 25, cacheRead: 50, cacheWrite: 0 });
    expect(existsSync(file)).toBe(false);
  });

  it("returns null when nothing was recorded", async () => {
    expect(await takeTurnUsage(mkdtempSync(path.join(tmpdir(), "usage-")), "none")).toBeNull();
  });
});
