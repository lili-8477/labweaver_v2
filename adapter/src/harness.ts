// Auto mode (the self-driving tick harness), adapter side. A chat's mode lives
// on its chats row. While a chat is in auto mode, ~/.claude/auto/<session id>
// marks its dsh session for the tick plugin and the harness hooks, and holds
// the session's project as one absolute path (empty until tick-bootstrap
// writes one). The adapter starts each auto-mode turn as `/tick <message>`;
// dsh-plugins/tick.js drives the rounds after that.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export const sessionFile = (home: string, sessionId: string): string =>
  path.join(home, ".claude", "auto", sessionId);

/** Route a typed message into the orchestrator; slash commands pass through. */
export function autoModePrompt(prompt: string): string {
  return prompt.trimStart().startsWith("/") ? prompt : `/tick ${prompt}`;
}

/**
 * Mark a session as auto mode, pointed at the chat's bound project
 * (workspace-relative), or at none so the next tick bootstraps one.
 */
export async function enterAutoMode(home: string, workspaceRoot: string, sessionId: string, projectDir: string | null): Promise<void> {
  const file = sessionFile(home, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, projectDir ? `${path.resolve(workspaceRoot, projectDir)}\n` : "");
}

export async function leaveAutoMode(home: string, sessionId: string): Promise<void> {
  await fs.rm(sessionFile(home, sessionId), { force: true });
}

/** The session's project, workspace-relative; null if none or outside the workspace. */
export async function recordedProject(home: string, workspaceRoot: string, sessionId: string): Promise<string | null> {
  const abs = (await fs.readFile(sessionFile(home, sessionId), "utf8").catch(() => "")).trim();
  const rel = abs ? path.relative(workspaceRoot, abs) : "";
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
}
