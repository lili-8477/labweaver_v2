import { describe, expect, it } from "vitest";
import { isListed, workspacePath } from "../src/workspace-path.js";

const ROOT = "/workspace";

describe("workspacePath", () => {
  it("resolves workspace-relative paths inside the root", () => {
    expect(workspacePath(ROOT, "local_projects/p/a.txt", "write")).toBe("/workspace/local_projects/p/a.txt");
    expect(workspacePath(ROOT, "./local_projects//p/", "read")).toBe("/workspace/local_projects/p");
    expect(workspacePath(ROOT, "", "read")).toBe("/workspace");
  });

  it("rejects absolute paths and any .. segment instead of rewriting them", () => {
    for (const access of ["read", "write"] as const) {
      expect(() => workspacePath(ROOT, "/workspace2/x", access)).toThrow(/workspace-relative/);
      expect(() => workspacePath(ROOT, "/etc/passwd", access)).toThrow(/workspace-relative/);
      expect(() => workspacePath(ROOT, "../etc/passwd", access)).toThrow(/\.\./);
      expect(() => workspacePath(ROOT, "local_projects/../../x", access)).toThrow(/\.\./);
    }
    expect(workspacePath(ROOT, "a..b/c..", "read")).toBe("/workspace/a..b/c..");
  });

  it("refuses secrets at any depth, for read and write", () => {
    for (const rel of [".env", "local_projects/p/.env.local", ".ssh/id_rsa", "local_projects/p/.git/config"]) {
      expect(() => workspacePath(ROOT, rel, "read")).toThrow(/secret/);
      expect(() => workspacePath(ROOT, rel, "write")).toThrow(/secret/);
    }
  });

  it("lets the UI read harness files but not write them, except skills", () => {
    for (const rel of [".labweaver/settings.json", ".labweaver/hooks/x.sh", ".labweaver", "CLAUDE.md", ".labweaver/shared.md", ".mcp.json"]) {
      expect(workspacePath(ROOT, rel, "read")).toBe(`/workspace/${rel}`);
      expect(() => workspacePath(ROOT, rel, "write")).toThrow(/harness/);
    }
    expect(workspacePath(ROOT, ".labweaver/skills/s/SKILL.md", "write")).toBe("/workspace/.labweaver/skills/s/SKILL.md");
    expect(() => workspacePath(ROOT, ".labweaver/skills", "write")).toThrow(/harness/);
    // Harness names only matter at the top level; a project may have its own.
    expect(workspacePath(ROOT, "local_projects/p/CLAUDE.md", "write")).toBe("/workspace/local_projects/p/CLAUDE.md");
  });

  it("never writes the workspace root itself", () => {
    expect(() => workspacePath(ROOT, "", "write")).toThrow(/root/);
    expect(() => workspacePath(ROOT, "./", "write")).toThrow(/root/);
  });
});

describe("isListed", () => {
  it("hides secrets and shows everything else", () => {
    expect(isListed(".env")).toBe(false);
    expect(isListed(".env.production")).toBe(false);
    expect(isListed(".git")).toBe(false);
    expect(isListed(".labweaver")).toBe(true);
    expect(isListed("data.csv")).toBe(true);
  });
});
