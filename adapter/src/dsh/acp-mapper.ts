// Pure mapping from ACP `session/update` payloads (as emitted by
// `dsh --profile acp`) to harness-neutral AgentEvents.
//
// DSH emits committed output only: one agent_message_chunk per text block,
// tool_call when a call starts, tool_call_update when it settles, and
// usage_update with context occupancy. Thoughts, plans and config changes have
// no frontend counterpart and are dropped.

import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../engine/types.js";

export function mapSessionUpdate(update: SessionUpdate): AgentEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text" && update.content.text
        ? [{ kind: "text", text: update.content.text }]
        : [];

    case "tool_call":
      return [{ kind: "tool_call", id: update.toolCallId, name: update.title, input: update.rawInput ?? {} }];

    case "tool_call_update":
      if (update.status !== "completed" && update.status !== "failed") return [];
      return [{
        kind: "tool_result",
        id: update.toolCallId,
        output: toolOutputText(update.content ?? []),
        isError: update.status === "failed",
      }];

    case "usage_update":
      return [{ kind: "usage", contextTokens: update.used, contextWindow: update.size }];

    default:
      return [];
  }
}

function toolOutputText(content: ToolCallContent[]): string {
  return content
    .map((c) => {
      if (c.type === "content") return c.content.type === "text" ? c.content.text : JSON.stringify(c.content);
      if (c.type === "diff") return `--- ${c.path}\n${c.newText}`;
      return JSON.stringify(c);
    })
    .join("\n");
}
