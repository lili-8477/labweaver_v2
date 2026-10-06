// Writes each turn as a Claude Code–format JSONL transcript at
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
//
// The memory pipeline (hub/indexer watcher, session projector, /memory
// distill) and get_chat_messages (history.ts) all read that format. DSH keeps
// its own session log for resume; this file is the stable interchange copy.
// Only the fields those readers use are written.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentEvent } from "../engine/types.js";
import { CONTINUATION_TYPE, transcriptPath } from "../history.js";

export interface TranscriptWriterOptions {
  home: string;
  cwd: string;
  sessionId: string;
  /** Recorded as message.model on assistant entries (indexer's sessions.model). */
  model: string;
  now?: () => Date;
}

export class ClaudeTranscriptWriter {
  private readonly file: string;
  private parentUuid: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** The latest assistant entry, held back so the turn's token usage can join it. */
  private pending: Record<string, unknown> | null = null;

  constructor(private readonly opts: TranscriptWriterOptions) {
    this.file = transcriptPath(opts.home, opts.cwd, opts.sessionId);
  }

  /**
   * Marks this session as continuing an earlier one (e.g. a pre-migration
   * Claude session DSH cannot resume). history.ts follows the link so the
   * chat's full history still renders; the indexer ignores unknown types.
   */
  continues(previousSessionId: string): void {
    this.release();
    this.enqueue(JSON.stringify({
      type: CONTINUATION_TYPE,
      sessionId: this.opts.sessionId,
      previousSessionId,
      timestamp: (this.opts.now?.() ?? new Date()).toISOString(),
    }) + "\n");
  }

  userPrompt(text: string): void {
    this.append("user", { role: "user", content: text });
  }

  event(ev: AgentEvent): void {
    switch (ev.kind) {
      case "text":
        this.append("assistant", { role: "assistant", model: this.opts.model, content: [{ type: "text", text: ev.text }] });
        break;
      case "tool_call":
        this.append("assistant", {
          role: "assistant",
          model: this.opts.model,
          content: [{ type: "tool_use", id: ev.id, name: ev.name, input: ev.input }],
        });
        break;
      case "tool_result":
        this.append("user", {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: ev.id, content: ev.output, is_error: ev.isError }],
        });
        break;
      case "usage":
        break; // context occupancy, not token usage
      case "tokens":
        // The turn's totals ride on its last assistant entry; the indexer
        // reads Claude-format message.usage from assistant lines.
        if (this.pending) {
          (this.pending.message as Record<string, unknown>).usage = {
            input_tokens: ev.input,
            output_tokens: ev.output,
            cache_read_input_tokens: ev.cacheRead,
            cache_creation_input_tokens: ev.cacheWrite,
          };
        }
        break;
    }
  }

  /** Resolves once every queued line is on disk. Never rejects. */
  flush(): Promise<void> {
    this.release();
    return this.chain;
  }

  private append(type: "user" | "assistant", message: Record<string, unknown>): void {
    this.release();
    const uuid = crypto.randomUUID();
    const entry = {
      type,
      uuid,
      parentUuid: this.parentUuid,
      sessionId: this.opts.sessionId,
      timestamp: (this.opts.now?.() ?? new Date()).toISOString(),
      cwd: this.opts.cwd,
      isSidechain: false,
      userType: "external",
      message,
    };
    this.parentUuid = uuid;
    if (type === "assistant") this.pending = entry;
    else this.enqueue(JSON.stringify(entry) + "\n");
  }

  private release(): void {
    if (!this.pending) return;
    this.enqueue(JSON.stringify(this.pending) + "\n");
    this.pending = null;
  }

  private enqueue(line: string): void {
    this.chain = this.chain
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.appendFile(this.file, line, "utf8");
      })
      .catch((e) => console.warn(`[transcript] append failed for ${this.file}:`, e));
  }
}
