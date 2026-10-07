// DeepSeek Harness plugin "sidechain". dsh loads this file itself, so it is
// plain ESM, not TypeScript. Mounted by the adapter's cordis patch: see
// src/dsh/patch.ts.
//
// Subagent runs (auto mode's bootstrap/planner/executor/reviewer, or any other
// delegation) happen in child sessions that dsh never streams over ACP, so the
// adapter's transcript only holds the parent's view. This writes each child
// session as its own Claude-format sidechain transcript beside the parent's:
// ~/.claude/projects/<encoded cwd>/<child session id>.jsonl, with
// isSidechain: true, parentSessionId linking it to the delegating session, and
// per-call message.usage. The hub indexer ingests it as an is_sidechain session
// (so subagent tokens are counted); the chat list already hides those.

import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const name = "sidechain";

/** Same encoding as transcriptPath in adapter/src/history.ts. */
const transcriptFile = (cwd, sessionId) =>
  join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"), `${sessionId}.jsonl`);

// dsh-injected context (skill catalog, runtime snapshot, workspace
// instructions) is environment, not trajectory.
const CONTEXT_FORMS = new Set(["catalog", "snapshot", "instructions"]);

const text = (blocks) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");

/** One session event as a Claude-format message, or null for events a transcript does not carry. */
export function toEntry(event) {
  const d = event.data;
  switch (event.type) {
    case "user/message":
      if (CONTEXT_FORMS.has(d.source?.form)) return null;
      return { type: "user", message: { role: "user", content: text(d.content) } };
    case "assistant/message": {
      const body = text(d.message.content);
      if (!body && !d.usage) return null;
      const message = { role: "assistant", content: body ? [{ type: "text", text: body }] : [] };
      const { provider, model } = d.message.source ?? {};
      if (model) message.model = provider ? `${provider}/${model}` : model;
      if (d.usage) {
        message.usage = {
          input_tokens: d.usage.inputTokens,
          output_tokens: d.usage.outputTokens,
          cache_read_input_tokens: d.usage.cacheReadTokens ?? 0,
          cache_creation_input_tokens: d.usage.cacheWriteTokens ?? 0,
        };
      }
      return { type: "assistant", message };
    }
    case "tool/call": {
      let input;
      try { input = JSON.parse(d.arguments); } catch { input = d.arguments; }
      return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: d.callId, name: d.name, input }] } };
    }
    case "tool/result":
      return {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: d.message.toolCallId, content: text(d.message.content), is_error: d.message.isError === true }],
        },
      };
    default:
      return null;
  }
}

export function apply(ctx) {
  const last = new Map(); // child session id -> uuid of its latest line

  ctx.on("session/event", (session, event) => {
    const h = session.header;
    if (!h.delegationDepth || !h.cwd) return;
    const entry = toEntry(event);
    if (!entry) return;
    const uuid = randomUUID();
    const file = transcriptFile(h.cwd, h.id);
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({
        ...entry,
        uuid,
        parentUuid: last.get(h.id) ?? null,
        sessionId: h.id,
        parentSessionId: h.parentSession,
        timestamp: new Date().toISOString(),
        cwd: h.cwd,
        isSidechain: true,
        userType: "external",
      }) + "\n");
      last.set(h.id, uuid);
    } catch (err) {
      ctx.logger.warn(`sidechain: append failed for ${file}: ${String(err)}`);
    }
  });
}
