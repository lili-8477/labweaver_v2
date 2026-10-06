// Auto mode (the self-driving tick harness), adapter side. The active project
// is one absolute path in ~/.claude/.harness_dir: tick.md and the hooks read
// it, tick-bootstrap writes it for a new project. The adapter keeps it in step
// with the chat's project_dir binding, and starts each auto-mode turn as
// `/tick <message>`; dsh-plugins/tick.js drives the rounds after that.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export const autoModeMarker = (home: string): string => path.join(home, ".claude", ".harness_active");
const projectFile = (home: string): string => path.join(home, ".claude", ".harness_dir");

export async function isAutoMode(home: string): Promise<boolean> {
  return fs.stat(autoModeMarker(home)).then(() => true, () => false);
}

/** Route a typed message into the orchestrator; slash commands pass through. */
export function autoModePrompt(prompt: string): string {
  return prompt.trimStart().startsWith("/") ? prompt : `/tick ${prompt}`;
}

/**
 * Point .harness_dir at the chat's bound project (workspace-relative), or
 * clear it so the next tick bootstraps a new one.
 */
export async function selectProject(home: string, workspaceRoot: string, projectDir: string | null): Promise<void> {
  if (projectDir) {
    await fs.writeFile(projectFile(home), `${path.resolve(workspaceRoot, projectDir)}\n`);
  } else {
    await fs.rm(projectFile(home), { force: true });
  }
}

/** The project tick-bootstrap recorded, workspace-relative; null if none or outside the workspace. */
export async function recordedProject(home: string, workspaceRoot: string): Promise<string | null> {
  const abs = (await fs.readFile(projectFile(home), "utf8").catch(() => "")).trim();
  const rel = abs ? path.relative(workspaceRoot, abs) : "";
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
}
