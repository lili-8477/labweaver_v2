// Reads a chat's Claude-format transcript (written by claude-jsonl.ts): the
// session's entries, oldest first, with every session it continues spliced in
// where the continuation link sits. The one place that knows the file layout
// and the link; chat-items.ts, chat-stats.ts and the first-turn digest read
// through it.

import { promises as fs } from "node:fs";
import { labweaverPath } from "../labweaver-dir.js";

/** One JSONL line. Only the fields the readers use are relied on. */
export type TranscriptEntry = Record<string, any>;

/** Canonical transcript path: Claude Code encodes cwd as "-absolute-path-with-dashes". */
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return labweaverPath(home, "projects", cwd.replace(/\//g, "-"), `${sessionId}.jsonl`);
}

/** Entry linking a session to the one it replaced (claude-jsonl.ts `continues`). */
export const CONTINUATION_TYPE = "labweaver-continuation";
const MAX_CONTINUATION_DEPTH = 8;

export interface Transcript {
  entries: TranscriptEntry[];
  /** The session and every session it continues. */
  sessions: Set<string>;
}

/** The session's entries and those of the sessions it continues; empty when there is no file. */
export async function readTranscript(home: string, cwd: string, sessionId: string): Promise<Transcript> {
  const out: Transcript = { entries: [], sessions: new Set() };
  const read = async (id: string, depth: number): Promise<void> => {
    out.sessions.add(id);
    const raw = await fs.readFile(transcriptPath(home, cwd, id), "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    for (const e of parseLines(raw)) {
      if (e.type === CONTINUATION_TYPE && typeof e.previousSessionId === "string") {
        if (depth < MAX_CONTINUATION_DEPTH) await read(e.previousSessionId, depth + 1);
        continue;
      }
      out.entries.push(e);
    }
  };
  await read(sessionId, 0);
  return out;
}

/** JSONL lines, skipping blanks and a torn last line. */
export function parseLines(raw: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn last line */ }
  }
  return out;
}
