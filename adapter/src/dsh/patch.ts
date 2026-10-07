// Builds the cordis patch the adapter layers over `dsh --profile acp`.
// Rows address dsh-base row ids; a patch row replaces that row's whole config.
// Output is JSON, which is valid YAML, so no YAML dependency is needed.

import type { McpServer } from "@agentclientprotocol/sdk";
import type { ProviderSpec } from "../providers/registry.js";
import { parseModelRef } from "../providers/registry.js";

export interface PatchOptions {
  providers: ProviderSpec[];
  /** Default "provider/model" for new sessions. */
  defaultModel: string;
  /** Extra skill roots, e.g. ~/.claude/skills (DSH does not scan .claude by default). */
  skillDirs: string[];
  /** Claude Code settings.json whose `hooks` DSH should run; omit to skip hooks. */
  hooksConfigPath?: string;
  /** file: URL of the adapter's dsh-plugins/ directory (ending in "/"); omit to skip its plugins. */
  pluginsDirUrl?: string;
  /**
   * MCP servers mounted process-wide, so subagents get their tools too
   * (servers passed per session over ACP reach only that session's agent).
   */
  mcpServers?: McpServer[];
}

type Row = Record<string, unknown>;

/** Adapter-owned dsh plugins, each at dsh-plugins/<id>.js. */
const LOCAL_PLUGINS = ["next-step", "tick", "usage", "sidechain"];

export function buildDshPatch(opts: PatchOptions): Row[] {
  const def = parseModelRef(opts.defaultModel);
  if (!def) throw new Error(`invalid default model ref: ${opts.defaultModel}`);

  const routes: Record<string, unknown> = {};
  for (const p of opts.providers) {
    if (!p.openaiCompatible) continue;
    routes[p.id] = {
      displayName: p.label,
      apiKeyEnv: p.apiKeyEnv,
      api: "openai-completions",
      baseURL: p.openaiCompatible.baseURL,
      models: p.models.map((m) => ({
        id: m.id,
        name: m.label,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: m.vision ? ["text", "image"] : ["text"],
        reasoningEfforts: false,
      })),
    };
  }

  const rows: Row[] = [
    { id: "llm-pi-ai", config: { providers: routes } },
    { id: "acp", config: { provider: def.provider, model: def.model } },
    { id: "skill-filesystem", config: { customSkillDirs: opts.skillDirs } },
  ];
  const inserts: Row[] = [];
  if (opts.hooksConfigPath) {
    inserts.push({
      id: "hooks-claude-code",
      name: "@deepseek-ai/dsh-hooks-claude-code",
      config: { configPath: opts.hooksConfigPath },
    });
  }
  if (opts.pluginsDirUrl) {
    for (const id of LOCAL_PLUGINS) inserts.push({ id, name: new URL(`${id}.js`, opts.pluginsDirUrl).href });
  }
  for (const s of opts.mcpServers ?? []) {
    const config = mcpClientConfig(s);
    if (config) inserts.push({ id: `mcp-${s.name}`, name: "@deepseek-ai/dsh-mcp-client", config });
  }
  if (inserts.length > 0) rows.push({ insert: inserts });
  return rows;
}

/** dsh-mcp-client config for the stdio and HTTP servers .mcp.json can declare; null otherwise. */
function mcpClientConfig(s: McpServer): Row | null {
  const pairs = (xs: { name: string; value: string }[]) => Object.fromEntries(xs.map((x) => [x.name, x.value]));
  if ("command" in s) return { serverName: s.name, transport: "stdio", command: s.command, args: s.args, env: pairs(s.env) };
  if ("type" in s && s.type === "http") return { serverName: s.name, transport: "streamable-http", url: s.url, headers: pairs(s.headers) };
  return null;
}

export function serializePatch(rows: Row[]): string {
  return JSON.stringify(rows, null, 2) + "\n";
}
