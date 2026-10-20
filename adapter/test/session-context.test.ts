import { describe, it, expect } from "vitest";
import { parentDigest, stripSessionContext, withSessionContext } from "../src/session-context.js";

describe("session context", () => {
  it("digest keeps recent user/assistant text and skips tool messages", () => {
    const digest = parentDigest([
      { kind: "user", id: "u", text: "load pbmc3k" },
      { kind: "tool", id: "t", name: "bash", input: {}, output: "ok", startedAt: "2026-01-01T00:00:00Z" },
      { kind: "text", id: "a", text: "Loaded 2700 cells." },
    ]);
    expect(digest).toBe("User: load pbmc3k\n\nAssistant: Loaded 2700 cells.");
  });

  it("digest drops the oldest turns to fit the size cap", () => {
    const long = "x".repeat(600);
    const msgs = Array.from({ length: 12 }, (_, i) => ({ kind: "user" as const, id: `u${i}`, text: `${i}${long}` }));
    const digest = parentDigest(msgs);
    expect(digest.length).toBeLessThanOrEqual(6000);
    expect(digest).toContain("User: 11");
    expect(digest).not.toContain("User: 0x");
  });

  it("no context leaves the prompt untouched", () => {
    expect(withSessionContext("hi", {})).toBe("hi");
  });

  it("block carries project + parent, is appended after the prompt, and strips for display", () => {
    const seeded = withSessionContext("/plot umap", {
      projectDir: "/workspace/local_projects/qc",
      parent: { name: "QC", transcript: "/t.jsonl", digest: "User: hi" },
    });
    expect(seeded.startsWith("/plot umap\n\n<session-context>")).toBe(true);
    expect(seeded).toContain("/workspace/local_projects/qc");
    expect(seeded).toContain("/t.jsonl");
    expect(stripSessionContext(seeded)).toBe("/plot umap");
  });

  it("strips the legacy parent-session block", () => {
    expect(stripSessionContext("hi\n\n<parent-session>\nx\n</parent-session>")).toBe("hi");
  });
});
