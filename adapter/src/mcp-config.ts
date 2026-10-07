// Reads a Claude Code `.mcp.json` into ACP-shaped `McpServer` entries, which
// dsh/patch.ts mounts process-wide through dsh-mcp-client. Bare stdio commands
// are resolved against PATH to absolute paths.

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";

interface McpJsonEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export async function resolveOnPath(cmd: string, envPath = process.env.PATH ?? ""): Promise<string | null> {
  if (path.isAbsolute(cmd)) return cmd;
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, cmd);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export async function loadMcpServers(file: string, envPath?: string): Promise<McpServer[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const servers = (JSON.parse(raw) as { mcpServers?: Record<string, McpJsonEntry> }).mcpServers ?? {};
  const out: McpServer[] = [];
  for (const [name, s] of Object.entries(servers)) {
    if (s.url) {
      out.push({
        type: "http",
        name,
        url: s.url,
        headers: Object.entries(s.headers ?? {}).map(([k, value]) => ({ name: k, value })),
      });
      continue;
    }
    if (!s.command) continue;
    const command = await resolveOnPath(s.command, envPath);
    if (!command) {
      console.warn(`[mcp] skipping ${name}: command not found on PATH: ${s.command}`);
      continue;
    }
    out.push({
      name,
      command,
      args: s.args ?? [],
      env: Object.entries(s.env ?? {}).map(([k, value]) => ({ name: k, value })),
    });
  }
  return out;
}
