import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpServers } from "../src/mcp-config.js";
import { expandSlashCommand, renderCommand } from "../src/slash-commands.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "slash-mcp-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("slash commands", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(dir, ".claude", "commands"), { recursive: true });
    await fs.writeFile(path.join(dir, ".claude", "commands", "recall.md"),
      "---\ndescription: search memory\n---\n# /recall\nCall memory_search with query = $ARGUMENTS.\n");
    await fs.writeFile(path.join(dir, ".claude", "commands", "memory.md"), "# /memory\nDistill this session.\n");
  });

  it("substitutes $ARGUMENTS and strips frontmatter", async () => {
    expect(await expandSlashCommand(dir, "/recall SS18-SSX2 fusion"))
      .toBe("# /recall\nCall memory_search with query = SS18-SSX2 fusion.");
  });

  it("expands commands without placeholders", async () => {
    expect(await expandSlashCommand(dir, "/memory")).toBe("# /memory\nDistill this session.");
    expect(renderCommand("Do it.", "extra")).toBe("Do it.\n\nARGUMENTS: extra");
  });

  it("passes unknown names (e.g. DSH skills) and plain text through", async () => {
    expect(await expandSlashCommand(dir, "/chip-seq call peaks")).toBe("/chip-seq call peaks");
    expect(await expandSlashCommand(dir, "hello /recall")).toBe("hello /recall");
  });
});

describe("loadMcpServers", () => {
  it("converts .mcp.json to ACP servers with absolute commands", async () => {
    const bin = path.join(dir, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "labweaver-memory-mcp"), "#!/bin/sh\n", { mode: 0o755 });
    const file = path.join(dir, ".mcp.json");
    await fs.writeFile(file, JSON.stringify({
      mcpServers: {
        "labweaver-memory": { command: "labweaver-memory-mcp", env: { USERNAME: "u", MEMORY_API_URL: "http://x:8400" } },
        missing: { command: "no-such-binary" },
        web: { type: "http", url: "https://mcp.example/mcp", headers: { "X-K": "v" } },
      },
    }));
    expect(await loadMcpServers(file, bin)).toEqual([
      {
        name: "labweaver-memory",
        command: path.join(bin, "labweaver-memory-mcp"),
        args: [],
        env: [{ name: "USERNAME", value: "u" }, { name: "MEMORY_API_URL", value: "http://x:8400" }],
      },
      { type: "http", name: "web", url: "https://mcp.example/mcp", headers: [{ name: "X-K", value: "v" }] },
    ]);
  });

  it("returns [] when the file is absent", async () => {
    expect(await loadMcpServers(path.join(dir, "nope.json"))).toEqual([]);
  });
});
