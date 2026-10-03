// Expands Claude Code–style slash commands (~/.claude/commands/<name>.md)
// before a prompt reaches the agent runtime. DSH has no markdown command
// loader; its own `/name` handling covers skills, so unknown names pass
// through untouched for DSH to resolve.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SLASH_RE = /^\/([A-Za-z0-9][\w-]*)(?:\s+([\s\S]*))?$/;

export function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n/, "");
}

export function renderCommand(body: string, args: string): string {
  const rendered = stripFrontmatter(body).replace(/\$ARGUMENTS/g, args).trim();
  // Claude Code appends arguments when the template has no placeholder.
  return body.includes("$ARGUMENTS") || !args ? rendered : `${rendered}\n\nARGUMENTS: ${args}`;
}

export async function expandSlashCommand(home: string, prompt: string): Promise<string> {
  const m = prompt.trim().match(SLASH_RE);
  if (!m) return prompt;
  const [, name, args = ""] = m;
  let body: string;
  try {
    body = await readFile(join(home, ".claude", "commands", `${name}.md`), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return prompt;
    throw e;
  }
  return renderCommand(body, args.trim());
}
