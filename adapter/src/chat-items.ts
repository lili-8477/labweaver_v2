// Chat items (GLOSSARY.md): what the chat view shows, in the order the agent
// produced it: user messages, text, and tool calls with their results.
//
// One projection from transcript entries to items serves both live turns and
// history. A live turn feeds each entry as the transcript writer creates it
// (turn-runner.ts) and streams the items that changed; get_chat_items feeds
// the stored transcript. Same entries, same ids, same times — so a finished
// turn looks exactly as it did while it ran.

import { stripSessionContext } from "./session-context.js";
import type { TranscriptEntry } from "./transcript/read.js";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      /** Absent until the result arrives; capped at MAX_TOOL_OUTPUT_CHARS. */
      output?: string;
      isError?: boolean;
      /** ISO timestamps of the call and of its result. */
      startedAt: string;
      endedAt?: string;
    };

/** Tool output kept per item: enough to read in the timeline, small enough
 *  that a long chat's items fit one NATS reply. The transcript keeps it all. */
export const MAX_TOOL_OUTPUT_CHARS = 4000;

export class ChatItemProjector {
  private items = new Map<string, ChatItem>();
  /** The text item consecutive assistant text extends, until something else arrives. */
  private openText: Extract<ChatItem, { kind: "text" }> | null = null;

  /** Feed one transcript entry, oldest first; returns the items it added or changed. */
  push(entry: TranscriptEntry): ChatItem[] {
    const changed: ChatItem[] = [];
    const blocks = contentBlocks(entry);
    if (entry.type === "assistant") {
      for (const b of blocks) {
        if (b.type === "text" && b.text) {
          if (this.openText) this.openText.text += `\n\n${b.text}`;
          else this.openText = this.add({ kind: "text", id: entryId(entry, "text"), text: String(b.text) });
          changed.push(this.openText);
        } else if (b.type === "tool_use") {
          this.openText = null;
          changed.push(this.add({ kind: "tool", id: String(b.id), name: String(b.name), input: b.input ?? {}, startedAt: entry.timestamp }));
        }
      }
    } else if (entry.type === "user") {
      // Synthetic user entries (skill loads, reminders) carry isMeta or a
      // sourceToolUseID; their text is not the user's, their tool results are.
      const isMeta = entry.isMeta === true || typeof entry.sourceToolUseID === "string";
      const text = blocks
        .filter((b) => b.type === "text" && !isMeta && !isSkillInjection(String(b.text ?? "")))
        .map((b) => String(b.text ?? ""))
        .join("");
      const shown = stripSessionContext(text);
      if (shown.trim()) {
        this.openText = null;
        changed.push(this.add({ kind: "user", id: entryId(entry, "user"), text: shown }));
      }
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const id = String(b.tool_use_id ?? "");
        const call = this.items.get(id);
        const result = {
          output: capOutput(resultText(b.content)),
          isError: b.is_error === true,
          endedAt: entry.timestamp,
        };
        if (call?.kind === "tool") Object.assign(call, result);
        // A result whose call isn't in this transcript still shows.
        changed.push(call ?? this.add({ kind: "tool", id, name: "tool", input: {}, startedAt: entry.timestamp, ...result }));
        this.openText = null;
      }
    }
    return changed.map((it) => ({ ...it }));
  }

  /** Every item so far, in order. */
  all(): ChatItem[] {
    return [...this.items.values()].map((it) => ({ ...it }));
  }

  private add<T extends ChatItem>(item: T): T {
    this.items.set(item.id, item);
    return item;
  }
}

/** The chat view of a whole transcript. */
export function projectItems(entries: TranscriptEntry[]): ChatItem[] {
  const p = new ChatItemProjector();
  for (const e of entries) p.push(e);
  return p.all();
}

function contentBlocks(entry: TranscriptEntry): TranscriptEntry[] {
  const c = entry.message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
}

let fallbackIds = 0;
function entryId(entry: TranscriptEntry, kind: string): string {
  return typeof entry.uuid === "string" ? entry.uuid : `${kind}-${++fallbackIds}`;
}

/** The skill payload Claude Code injected after a Skill call, in older
 *  transcripts that lack isMeta. */
function isSkillInjection(text: string): boolean {
  return /^Base directory for this skill:\s*\S+(?:\.claude|\.labweaver|shared)\/skills\//.test(text.trimStart());
}

function resultText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.map((p) => (p?.type === "text" ? String(p.text ?? "") : JSON.stringify(p))).join("\n");
  }
  return raw == null ? "" : JSON.stringify(raw);
}

function capOutput(s: string): string {
  return s.length <= MAX_TOOL_OUTPUT_CHARS ? s : `${s.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…[truncated]`;
}
