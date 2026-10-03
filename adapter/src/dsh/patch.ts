// Builds the cordis patch the adapter layers over `dsh --profile acp`.
// Rows address dsh-base row ids; a patch row replaces that row's whole config.
// Output is JSON, which is valid YAML, so no YAML dependency is needed.

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
}

type Row = Record<string, unknown>;

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
  if (opts.hooksConfigPath) {
    rows.push({
      insert: [
        {
          id: "hooks-claude-code",
          name: "@deepseek-ai/dsh-hooks-claude-code",
          config: { configPath: opts.hooksConfigPath },
        },
      ],
    });
  }
  return rows;
}

export function serializePatch(rows: Row[]): string {
  return JSON.stringify(rows, null, 2) + "\n";
}
