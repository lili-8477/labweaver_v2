// First-turn context for a fresh engine session: the project folder the chat
// lives in, and — for a sub-session — a digest of the parent conversation plus
// the parent transcript path for anything the digest drops. The block is
// appended after the user's text (slash commands and mode routing stay
// intact) and stripped again when history is shown.

import type { LegacyMessage } from "./history.js";

const TAG = "session-context";
const MAX_TURNS = 12;
const MAX_CHARS_PER_TURN = 600;
const MAX_TOTAL_CHARS = 6000;

export interface SessionContext {
  /** Absolute project directory the session works in. */
  projectDir?: string;
  parent?: { name: string; transcript: string; digest: string };
}

/** Last few user/assistant exchanges of the parent, oldest first, capped. */
export function parentDigest(messages: LegacyMessage[]): string {
  const turns = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => {
      const text = stripSessionContext(m.content).trim();
      const clipped = text.length > MAX_CHARS_PER_TURN ? `${text.slice(0, MAX_CHARS_PER_TURN)}…` : text;
      return `${m.role === "user" ? "User" : "Assistant"}: ${clipped}`;
    });
  // Drop oldest turns until the digest fits.
  while (turns.length > 1 && turns.join("\n\n").length > MAX_TOTAL_CHARS) turns.shift();
  return turns.join("\n\n");
}

export function withSessionContext(prompt: string, ctx: SessionContext): string {
  const lines: string[] = [];
  if (ctx.projectDir) {
    lines.push(`This chat belongs to the project at ${ctx.projectDir}. Work there and keep all outputs inside it.`);
  }
  if (ctx.parent) {
    lines.push(
      `This chat is a sub-session branched from the chat "${ctx.parent.name}".`,
      `Use the parent's context below as background; the full parent transcript is at ${ctx.parent.transcript}.`,
    );
    if (ctx.parent.digest) lines.push(`\nRecent parent conversation:\n${ctx.parent.digest}`);
  }
  return lines.length ? `${prompt}\n\n<${TAG}>\n${lines.join("\n")}\n</${TAG}>` : prompt;
}

// "parent-session" is the tag sub-sessions used before projects joined the block.
const BLOCK = new RegExp(`\\n*<(${TAG}|parent-session)>[\\s\\S]*?</\\1>`, "g");

/** Remove an injected context block from user-visible text. */
export function stripSessionContext(text: string): string {
  return text.replace(BLOCK, "");
}
